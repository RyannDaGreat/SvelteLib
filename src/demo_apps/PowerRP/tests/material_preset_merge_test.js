/**
 * WIDGET-PRESET MERGE test (Round 4 #52/#53, user rule: "the demo widget
 * should determine the types of presets that these have. You can add them
 * together to make more"). Bare-node. Pins presetsForMaterial(id, registry):
 * the widget's own roster comes FIRST (it is the authority), this repo's
 * curated entries follow as extras deduped by title, every merged param is a
 * knob the material's schema actually knows, and a null registry degrades to
 * extras-only (the bare-node/no-UI case).
 *
 * Run: node tests/material_preset_merge_test.js
 */
import { presetsForMaterial, widgetPresetsFor } from "../render_gpu/skia/material_presets.js";
import { getMaterial, materialIds } from "../render_gpu/skia/materials.js";
import { registerAll } from "../plugins/index.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// The reported gap that started #52: glitch's widget presets (HUD Flicker et
// al) were invisible on the MATERIAL. They must now lead the material's list.
const glitch = presetsForMaterial("glitch", registry);
const glitchWidget = widgetPresetsFor(registry.get("demo_glitch"), getMaterial("glitch").fillParams);
ok(glitchWidget.length >= 4, `glitch widget contributes a real roster (${glitchWidget.length} presets)`);
ok(glitch.some((p) => p.title === "HUD Flicker"), 'the missing "sci-fi preset" — HUD Flicker — reaches the material');
ok(
  glitch.slice(0, glitchWidget.length).map((p) => p.title).join("|") === glitchWidget.map((p) => p.title).join("|"),
  "widget presets come FIRST, in the widget's own order (the widget is the authority)"
);
ok(glitch.length > glitchWidget.length, "curated extras survive AFTER the widget's roster (add them together to make more)");

// Liquid glass (#53): the glass widget's Material family leads the glass material.
const glass = presetsForMaterial("glass", registry);
ok(glass[0]?.title === "Liquid Glass", `glass leads with the widget's Liquid Glass preset (got ${JSON.stringify(glass[0]?.title)})`);
ok(glass.every((p) => Object.keys(p.params).length > 0), "silhouette-only widget presets are excluded (they say nothing about the fill)");

// Schema discipline + dedupe, across EVERY sourced material.
for (const id of ["glitch", "crt", "glass", "metaballs", "corkboard", "frosted", "sky", "lens_flare", "comic", "mandelbrot"]) {
  if (!materialIds().includes(id)) { ok(false, `sourced material "${id}" no longer exists`); continue; }
  const merged = presetsForMaterial(id, registry);
  const known = new Set(getMaterial(id).fillParams.map((r) => r.name));
  const badKnob = merged.flatMap((p) => Object.keys(p.params).filter((k) => !known.has(k)).map((k) => `${p.title}.${k}`));
  ok(badKnob.length === 0, `${id}: every merged param is a schema knob${badKnob.length ? ` (leaked: ${badKnob.join(", ")})` : ""}`);
  const titles = merged.map((p) => p.title);
  ok(new Set(titles).size === titles.length, `${id}: titles are deduped (${titles.length} unique)`);
}

// No registry (bare node, CLI) → extras only, no throw.
const bare = presetsForMaterial("glitch");
ok(bare.length > 0 && bare.every((p) => !p.id.startsWith("widget:")), "null registry degrades to curated extras only");

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS — widget-preset merge (widget-first, schema-filtered, deduped, node-safe)");
