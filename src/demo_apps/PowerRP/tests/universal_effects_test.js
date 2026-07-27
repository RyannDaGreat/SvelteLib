/**
 * UNIVERSAL EFFECTS BUNDLE guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/universal_effects_test.js
 *
 * WHY THIS EXISTS. Composing the shared effects bundle used to be FOUR
 * HAND-COPIED LINES per plugin file — `...bundleNestedDefaults("effects")` in
 * defaults, `...bundle("effects")` in inspector, `applyEffects(...)` inside
 * emit(), and `cullMargin: effectsCullMargin` — and nothing enforced any of
 * them. 28 of 74 plugins had ZERO effect rows, only three of them justifiably.
 * That is the gap the user reported verbatim: "Why does Frosted Glass not have a
 * soft edges option like all the other things? ... Why is there no drop shadow
 * option on the Frosted Glass? Why doesn't the magnifier have drop shadows and
 * other options like this too? Soft edges should be an option for everything
 * that we can give it to. As well as drop shadows, etc."
 *
 * Eligibility is now structural: core/registry.register() injects the property
 * half into every eligible plugin, and render_gpu/ports.js applies the render
 * half. This suite is the ratchet — it fails if a widget type ever silently
 * loses the bundle again.
 *
 * WHAT IT PROVES, over EVERY registered plugin (not a sample):
 *   (1) COVERAGE — every plugin carries all five effects' rows, or is INELIGIBLE
 *       for a declared reason (the promoted audit matrix, asserted all-Y).
 *   (2) the ineligible set is exactly the four declared exclusion reasons, and
 *       every excluded plugin has NO effect row at all (no fake half-support).
 *   (3) every plugin with effect rows also has the effect-OFF DEFAULTS, so an
 *       untouched widget is byte-identical and old documents self-heal.
 *   (4) an injected plugin declares the cull margin, so its halo is not culled.
 *   (5) EXACTLY ONE WRAP: sceneIR wraps an injected plugin's ops in one
 *       effectSubtree, leaves a self-composing plugin's own wrap alone, and
 *       wraps nothing at all when every effect is off (the byte-identity gate).
 *   (6) an injected plugin can always be bounded (bbox or an effectBounds hook).
 */

import assert from "node:assert/strict";
import { allPlugins } from "../plugins/index.js";
import { createRegistry, effectsInjectable, composesEffects } from "../core/registry.js";
import { BUNDLES } from "../core/properties.js";
import { sceneIR } from "../render_gpu/ports.js";
import { EFFECT_STATE_KEYS, effectBoundsOf } from "../render_gpu/effects.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
for (const p of allPlugins) registry.register(p);
const registered = registry.all();

// The five effects' GATE rows — one per effect, the keys effectsOff() reads.
const GATE_ROWS = ["shadow.opacity", "bloom.strength", "innerShadow.opacity", "softEdges", "blendMode"];

/** Pure function. Why can the registry not INJECT the bundle into `plugin` — or
 *  null if it can. Mirrors core/registry.effectsInjectable, spelled out so a
 *  failure names the reason instead of just saying "false". NOTE: not injectable
 *  does NOT mean unsupported — the arrow family composes the bundle itself. */
function injectionBlocker(plugin) {
  const caps = plugin.capabilities ?? {};
  if (caps.purgeable === false) return "purgeable:false (THE camera — the view definition, not a drawn widget)";
  if (caps.ghost && !plugin.foldsSubtree) return "ghost without foldsSubtree (a clip region / editor chrome — no rendered volume)";
  if (!caps.bbox && !plugin.effectBounds) return "no bbox and no effectBounds hook (no local render footprint to bound the substrate)";
  return null;
}

/** Pure function. Does the REGISTERED plugin offer the whole effects bundle? */
function hasBundle(plugin) {
  const keys = new Set((plugin.inspector ?? []).map((r) => r.key));
  return BUNDLES.effects.every((k) => keys.has(k));
}

test("(1) COVERAGE: every plugin the registry can inject into carries all five effects' rows", () => {
  const gaps = [];
  for (const p of registered) {
    if (injectionBlocker(p)) continue;
    const keys = new Set((p.inspector ?? []).map((r) => r.key));
    const missing = GATE_ROWS.filter((k) => !keys.has(k));
    if (missing.length) gaps.push(`${p.type} missing ${missing.join(", ")}`);
  }
  assert.deepEqual(gaps, [], `plugins missing effect rows:\n    ${gaps.join("\n    ")}`);
  // And the whole bundle, not just the gate rows.
  for (const p of registered) {
    if (injectionBlocker(p)) continue;
    assert.ok(hasBundle(p), `${p.type} is missing part of the effects bundle`);
  }
});

test("(2) the ONLY plugins WITHOUT the bundle are the declared exclusions", () => {
  // THE PROMOTED AUDIT MATRIX, asserted all-Y: this list was 28 types long when
  // eligibility was four hand-copied lines. Each remaining entry must be blocked
  // for a declared reason — a widget can no longer fall off silently.
  // corkboardYarn LEFT this list by declaring an `effectBounds` hook: it has no
  // bbox (it is a sagging curve between two thumbtacks), so it was blocked only
  // for want of a render footprint to bound the effect substrate with. Declaring
  // the hook is exactly the documented way to become eligible — which is the
  // point of the hook, and the reason this list must shrink, never grow.
  const without = registered.filter((p) => !hasBundle(p)).map((p) => p.type).sort();
  assert.deepEqual(without, ["anchor_point", "blur", "camera", "cropbox"]);
  for (const t of without) {
    const reason = injectionBlocker(registry.get(t));
    assert.ok(reason, `${t} has no effect rows and NO declared reason — that is the drift this suite exists to catch`);
    // No PARTIAL support either: an excluded type offers not one effect row.
    const keys = new Set((registry.get(t).inspector ?? []).map((r) => r.key));
    for (const k of BUNDLES.effects)
      assert.ok(!keys.has(k), `${t} is excluded (${reason}) yet offers effect row "${k}" — a control with no honest implementation`);
  }
  // The arrow family is NOT injectable yet DOES support every effect (it composes
  // the bundle in its own emit) — the distinction the predicate name records.
  for (const t of ["arrow", "line", "tangent_lines", "fancy_arrow", "elbow_arrow", "curved_arrow"]) {
    assert.equal(effectsInjectable(registry.get(t)), false, `${t} has no bbox, so the registry cannot inject into it`);
    assert.ok(hasBundle(registry.get(t)), `${t} must still offer the whole bundle through its own emit()`);
  }
  for (const p of registered) assert.equal(effectsInjectable(p), injectionBlocker(p) === null, `effectsInjectable disagrees for ${p.type}`);
});

test("(3) effect rows always come with defaults, and an INJECTED plugin's are all OFF", () => {
  for (const p of registered) {
    if (!hasBundle(p)) continue;
    for (const key of EFFECT_STATE_KEYS)
      assert.ok(key in p.defaults, `${p.type} offers effect rows but its defaults lack "${key}" — the row would edit a key the state does not have`);
    // BYTE-IDENTITY, but only where the registry chose the values: an injected
    // plugin must render exactly as it did before injection, so every effect it
    // gained is OFF. A SELF-composing plugin may deliberately default one ON for
    // its own look (demo_lens_flare ships blendMode "screen" — a flare is
    // additive by nature), and that is the plugin author's call, not this
    // suite's.
    if (!p.effectsInjected) continue;
    assert.equal(p.defaults.shadow.opacity, 0, `${p.type} injected default shadow must be OFF`);
    assert.equal(p.defaults.innerShadow.opacity, 0, `${p.type} injected default inner shadow must be OFF`);
    assert.equal(p.defaults.bloom.strength, 0, `${p.type} injected default bloom must be OFF`);
    assert.equal(p.defaults.blendMode, "normal", `${p.type} injected default blend must be normal`);
    assert.equal(p.defaults.softEdges, 0, `${p.type} injected default soft edges must be OFF`);
  }
});

test("(4) every BOUNDABLE plugin with the bundle declares the effect cull margin", () => {
  for (const p of registered) {
    // Gated on BOUNDABLE, not on `capabilities.bbox`. The old gate read "a
    // non-bbox widget never cull-skips at all, so a cull margin would have
    // nothing to inflate" — true until #194 gave the two-point widgets real
    // bounds (core/view.js localBoundsOf). They cull now, so their halo can be
    // clipped by the AABB test exactly like a box widget's, and they must declare
    // the margin. Only a genuinely UNBOUNDABLE widget (blur) is exempt.
    const boundable = p.capabilities?.bbox === true || typeof p.localBounds === "function";
    if (!hasBundle(p) || !boundable) continue;
    assert.equal(typeof p.cullMargin, "function", `${p.type} has effect rows but no cullMargin — its shadow/bloom halo would be culled at the view edge`);
    assert.equal(p.cullMargin({}), 0, `${p.type} cullMargin must be 0 with no effects (culling untouched by default)`);
    assert.ok(p.cullMargin({ shadow: { dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5 } }) === 11, `${p.type} cullMargin must report the shadow halo`);
  }
});

test("(5) EXACTLY ONE WRAP: injected plugins are wrapped by the walker, self-composing ones are not", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const node = (plugin, extra) => ({
    itemId: "i", type: plugin.type, plugin, world,
    state: { ...plugin.defaults, x: 0, y: 0, w: 200, h: 150, rotation: 0, scale: 1, ...extra },
  });
  const countEffects = (ops) => ops.filter((c) => c.op === "effectSubtree").length;

  const injected = registered.filter((p) => p.effectsInjected);
  const selfComposing = registered.filter((p) => !p.effectsInjected && hasBundle(p));
  assert.ok(injected.length > 0 && selfComposing.length > 0, "both populations must exist for this to mean anything");

  // A representative from each population that emits something for a bare state.
  const frosted = registry.get("demo_frosted_glass");
  const rect = registry.get("rect");
  assert.ok(frosted.effectsInjected, "demo_frosted_glass must be walker-wrapped (the user's headline case)");
  assert.ok(!rect.effectsInjected, "rect composes the bundle in its own emit()");

  for (const plugin of [frosted, rect]) {
    assert.equal(countEffects(sceneIR([node(plugin, {})])), 0, `${plugin.type}: effects OFF must emit NO effectSubtree (byte-identity)`);
    for (const on of [{ softEdges: 8 }, { shadow: { dx: 4, dy: 4, blur: 3, color: "#000000", opacity: 0.7 } }, { bloom: { radius: 6, strength: 0.5 } }, { blendMode: "multiply" }, { innerShadow: { dx: 2, dy: 2, blur: 4, color: "#000000", opacity: 0.6 } }]) {
      const ops = sceneIR([node(plugin, on)]);
      assert.equal(countEffects(ops), 1, `${plugin.type} with ${JSON.stringify(on)}: expected EXACTLY ONE effectSubtree, got ${countEffects(ops)}`);
    }
  }
});

test("(6) every injected plugin's effect substrate can be bounded", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  for (const plugin of registered) {
    if (!plugin.effectsInjected) continue;
    const { bbox, world: w } = effectBoundsOf({ plugin, state: { ...plugin.defaults, w: 200, h: 150 }, world });
    assert.ok(w, `${plugin.type} effect bounds must carry a world`);
    if (plugin.effectBounds) {
      // A plugin that DECLARES the hook is exactly the case the hook exists for:
      // it has no bbox to fall back on (corkboardYarn is a sagging curve between
      // two thumbtacks), so it reports its own drawn hull plus effect spill. Only
      // require that the substrate is real and finite — asserting {w,h} here would
      // demand the default from the one shape that cannot use it.
      assert.ok(Number.isFinite(bbox.x) && Number.isFinite(bbox.y), `${plugin.type} effectBounds must give a finite origin`);
      assert.ok(bbox.w > 0 && bbox.h > 0, `${plugin.type} effectBounds must give a non-degenerate substrate`);
      continue;
    }
    assert.equal(bbox.w, 200, `${plugin.type} effect bbox width must follow its state`);
    assert.equal(bbox.h, 150, `${plugin.type} effect bbox height must follow its state`);
  }
});

test("composesEffects only reports plugins that authored the rows themselves", () => {
  const authored = allPlugins.filter(composesEffects).map((p) => p.type);
  for (const t of authored) assert.ok(!registry.get(t).effectsInjected, `${t} authored the bundle, so nothing must have been injected into it`);
  for (const p of registered) {
    if (!p.effectsInjected) continue;
    assert.ok(!authored.includes(p.type), `${p.type} cannot be both injected and self-composing`);
  }
});

console.log(`\n${passed} checks passed over ${registered.length} registered plugins (${registered.filter((p) => p.effectsInjected).length} injected, ${registered.filter((p) => !p.effectsInjected && hasBundle(p)).length} self-composing, ${registered.filter((p) => !hasBundle(p)).length} ineligible).`);
