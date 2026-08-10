/**
 * WORKSTREAM BF — Copy/Paste Properties carries the UNIVERSAL section, and
 * pasting a widget TYPE is a transmutation that actually renders.
 * Run: node src/demo_apps/PowerRP/tests/paste_universal_test.js
 *
 * THE RULING under test (user, 2026-08-02, verbatim): "Why does copy properties
 * not copy the widget type and visibility and everything under universal other
 * than name? Copy properties should do that, but it doesn't seem to. Can you
 * double check that? See if I'm wrong? Maybe it's pasted the issue. I don't
 * know."
 *
 * WHY THIS FILE EXISTS BESIDE paste_targeting_test.js: that suite pins the
 * RETARGET RULE with hand-built fixtures, which is the right unit for a contract
 * relation. This one runs the REAL registry and the REAL document model, because
 * the two halves of the defect were only visible there:
 *   1. `morph` was refused by a rule that was TRUE of every fixture — a fixture
 *      declaring a morph row would have hidden the blind spot entirely.
 *   2. The transmutation's survivors/defaults are a fact about actual plugins.
 *
 * THE MEASUREMENT THAT FOUND IT, kept because "double check that" was the ask
 * and the answer is a number: 0 of 107 registered plugins declare `type`,
 * `name`, `active` or `morph` — those rows live in web/Inspector.svelte's
 * `universalCategory` and core/multiselect.js's `universalRows`. The COPY side
 * was never at fault; it captured all four every time.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, slideState } from "../core/document.js";
import { applied } from "../core/deltas.js";
import { deriveRenderTree } from "../core/derive.js";
import { retypedItem, retypeEligible } from "../core/retype.js";
import {
  itemPropertiesPayload, itemPropertiesDelta, retargetedPayload, partitionPurged,
  UNIVERSAL_PASTE_KEYS, UNRETARGETABLE_KEYS, universalRefusal,
} from "../core/item_properties_clipboard.js";
import { UNIVERSAL_MULTI_KEYS } from "../core/multiselect.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);
const SLIDE_W = 1280;
const SLIDE_H = 720;

/** Query. A widget bag of `type` at a fixed box, with `extra` overriding. */
function widget(type, extra = {}) {
  return {
    ...registry.get(type).defaults, type,
    x: 100, y: 100, w: 200, h: 150, z: 1, rotation: 0, scale: 1, active: true, ...extra,
  };
}

/** Query. A one-slide document holding `items` beside the mandatory camera. */
function docWith(items) {
  return repairedDocument({
    meta: { name: "bf", slideW: SLIDE_W, slideH: SLIDE_H },
    slides: [{
      id: "s0", name: "S", transition: { type: "cut", seconds: 0, curve: "linear", sound: "" },
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 0, rotation: 0, scale: 1, active: true },
          ...items,
        },
      },
    }],
  }, registry).doc;
}

/**
 * Query. THE PASTE, exactly as web/app.svelte.js `#applyItemProperties` performs
 * it: retarget onto the selection, transmute any type change through the retype
 * plan, then merge the property delta into the SAME document — which is what
 * makes one paste one undo unit.
 */
function pastedOntoSelection(doc, sourceId, targetIds) {
  const fold = slideState(doc, 0);
  const payload = itemPropertiesPayload(fold, [sourceId]);
  const targets = targetIds.map((itemId) => ({ itemId, plugin: registry.get(fold.items[itemId].type) }));
  const { payload: retargeted } = retargetedPayload(payload, registry.get(fold.items[sourceId].type), targets);
  const { surviving } = partitionPurged(retargeted, fold);
  let out = doc;
  for (const id of surviving) {
    const wanted = retargeted.powerrp_item_props[id]?.type;
    const current = fold.items[id];
    if (typeof wanted !== "string" || !current || current.type === wanted) continue;
    if (!retypeEligible(registry.get(current.type)) || !retypeEligible(registry.get(wanted))) continue;
    out = retypedItem(out, 0, id, wanted, current, registry);
  }
  const delta = itemPropertiesDelta(retargeted, fold);
  return {
    ...out,
    slides: out.slides.map((s, i) => (i === 0 ? { ...s, delta: applied(s.delta, delta) } : s)),
  };
}

// ── THE MEASUREMENT THAT PROVED THE USER RIGHT ───────────────────────────────

test("the COPY side was never at fault — the payload carries every universal key", () => {
  const doc = docWith({ src: widget("rect", { name: "Src", active: false, morph: "crossfade" }) });
  const copied = itemPropertiesPayload(slideState(doc, 0), ["src"]).powerrp_item_props.src;
  for (const key of ["type", "name", "active", "morph"])
    assert.ok(key in copied, `Copy Properties dropped "${key}" — but the defect was never on this side`);
});

test("NO plugin declares a universal row — the blind spot, as a number", () => {
  for (const key of ["type", "name", "active", "morph"]) {
    const declaring = registry.all().filter((p) => (p.inspector ?? []).some((r) => r.key === key));
    assert.equal(declaring.length, 0,
      `${declaring.length} plugin(s) now declare a "${key}" row. If that is deliberate, the ` +
      "universal-key branch in retargetedState must be revisited — it exists precisely because " +
      "the plugin-declaration rule cannot see these rows.");
  }
});

// ── THE RULING ───────────────────────────────────────────────────────────────

test("paste carries type + visible + morph onto a DIFFERENT widget type", () => {
  const doc = docWith({
    src: widget("rect", { name: "Src", active: false, morph: "crossfade", fill: "#ff0000" }),
    dst: widget("circle", { name: "Dst", active: true, morph: "snap", fill: "#0000ff" }),
  });
  const after = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0).items.dst;
  assert.equal(after.type, "rect", "widget TYPE did not transfer");
  assert.equal(after.active, false, "VISIBLE did not transfer");
  assert.equal(after.morph, "crossfade", "MORPH did not transfer");
  assert.equal(after.fill, "#ff0000", "an ordinary property stopped transferring");
});

test("NAME is untouched — the one universal row the ruling excludes", () => {
  const doc = docWith({
    src: widget("rect", { name: "Src" }),
    dst: widget("circle", { name: "Dst" }),
  });
  const after = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0).items.dst;
  assert.equal(after.name, "Dst", "the target's name was overwritten — a name identifies ONE widget");
  assert.ok("name" in UNRETARGETABLE_KEYS, "name must be refused BY NAME, with a reason, not by omission");
});

test("Z is untouched — stacking is the target's place in THIS slide", () => {
  const doc = docWith({ src: widget("rect", { z: 1 }), dst: widget("circle", { z: 5 }) });
  const after = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0).items.dst;
  assert.equal(after.z, 5, "the target was restacked by a paste that only copied appearance");
});

test("the universal subset IS core/multiselect's — imported, never restated", () => {
  assert.deepEqual(UNIVERSAL_PASTE_KEYS, UNIVERSAL_MULTI_KEYS,
    "BF and BE must share one list, or a row added to one silently misses the other");
  assert.deepEqual([...UNIVERSAL_PASTE_KEYS].sort(), ["active", "delay", "morph", "type"]);
});

// ── THE TRANSMUTATION ────────────────────────────────────────────────────────

test("a transmuted widget RENDERS — derive produces a node of the pasted type", () => {
  const doc = docWith({
    src: widget("text", { text: "hello" }),
    dst: widget("circle", { active: true }),
  });
  const after = pastedOntoSelection(doc, "src", ["dst"]);
  const node = deriveRenderTree(slideState(after, 0), registry).find((n) => n.itemId === "dst");
  assert.ok(node, "the transmuted widget vanished from the render tree");
  assert.equal(node.type, "text", "it did not become the pasted type");
});

test("transmutation FILLS the new type's defaults — a bare type keyframe would not", () => {
  // core/retype.js's whole reason: defaults are materialized only at the load
  // boundary, so a raw `type` write leaves the new plugin's keys undefined.
  const doc = docWith({ src: widget("text", { text: "hi" }), dst: widget("circle") });
  const after = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0).items.dst;
  for (const key of ["size", "font", "align"])
    assert.notEqual(after[key], undefined,
      `"${key}" is undefined after a transmute — the coercion plan did not run, and text's emit() would meet a hole`);
});

test("transmutation SURVIVORS: shared keys keep their pasted values, geometry included", () => {
  const doc = docWith({
    src: widget("rect", { x: 10, y: 20, w: 30, h: 40, opacity: 0.5 }),
    dst: widget("circle", { x: 999, y: 999 }),
  });
  const after = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0).items.dst;
  assert.deepEqual(
    { x: after.x, y: after.y, w: after.w, h: after.h, opacity: after.opacity },
    { x: 10, y: 20, w: 30, h: 40, opacity: 0.5 },
    "keys BOTH types declare must carry their copied values across the transmute",
  );
});

test("the item KEEPS ITS IDENTITY across a transmute — same id, same slot", () => {
  const doc = docWith({ src: widget("text"), dst: widget("circle", { name: "Keep" }) });
  const fold = slideState(pastedOntoSelection(doc, "src", ["dst"]), 0);
  assert.ok(fold.items.dst, "the id changed — a transmute must not destroy and recreate");
  assert.equal(fold.items.dst.name, "Keep", "the name did not survive the transmute");
});

test("ONE PASTE IS ONE UNDO UNIT — the transmute and the properties are one document", () => {
  // The composition law: #applyItemProperties merges the property delta into the
  // document the retype produced, and commits ONCE. So reverting to the
  // pre-paste document restores BOTH halves — there is no intermediate state in
  // which the type changed but the properties did not.
  const doc = docWith({
    src: widget("text", { text: "hi", active: false }),
    dst: widget("circle", { active: true }),
  });
  const before = slideState(doc, 0).items.dst;
  const after = pastedOntoSelection(doc, "src", ["dst"]);
  const pasted = slideState(after, 0).items.dst;
  assert.notEqual(pasted.type, before.type, "the premise: this paste really did transmute");
  assert.notEqual(pasted.active, before.active, "the premise: it also carried a universal property");
  // ONE slide delta holds both, so ONE undo reverts both.
  assert.equal(after.slides.length, doc.slides.length, "a paste must not add a slide");
  assert.deepEqual(slideState(doc, 0).items.dst, before, "the source document was mutated in place");
});

test("a structural target is REFUSED, not thrown at — the camera keeps its type", () => {
  // retypeEligible gates the camera/group/ghost/metaball; the paste declines
  // rather than writing a type the deriver cannot fold.
  assert.equal(retypeEligible(registry.get("camera")), false, "the premise: a camera cannot be retyped");
  const doc = docWith({ src: widget("rect") });
  const after = slideState(pastedOntoSelection(doc, "src", ["cam"]), 0).items.cam;
  assert.equal(after.type, "camera", "the camera was retyped — a structural widget must be refused");
});

test("universalRefusal's structural marks AGREE with retypeEligible, roster-wide", () => {
  // core/item_properties_clipboard is pure core with no registry, so it reads the
  // four capability marks itself instead of importing retypeEligible. That is a
  // duplicated rule, and this is what keeps it honest: every registered plugin
  // must get the same verdict from both, or a widget becomes retypeable by paste
  // and not by the Widget-type row (or the reverse).
  for (const plugin of registry.all()) {
    const refusedHere = universalRefusal("type", plugin) !== null;
    assert.equal(refusedHere, !retypeEligible(plugin),
      `"${plugin.type}": universalRefusal says ${refusedHere ? "refuse" : "allow"} but retypeEligible says ` +
      `${retypeEligible(plugin) ? "allow" : "refuse"} — the duplicated capability marks have drifted`);
  }
});

test("the camera also refuses `active` — it is mandatory and cannot be hidden", () => {
  const doc = docWith({ src: widget("rect", { active: false }) });
  const after = slideState(pastedOntoSelection(doc, "src", ["cam"]), 0).items.cam;
  assert.equal(after.active, true, "the mandatory camera was hidden by a paste");
});

console.log(`\npaste_universal: ${passed} passed`);
