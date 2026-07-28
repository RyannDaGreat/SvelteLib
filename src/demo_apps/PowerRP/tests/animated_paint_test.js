/**
 * ANIMATED-PAINT detection test (manifest item 73: "why does the rainy window
 * material not animate when I apply it to something?"). Bare-node. Pins the
 * paintIsAnimated seam the presenter's repaint-loop decision reads: every
 * material whose shader reads particleTime MUST declare `animated` (else it
 * freezes at rest in the presenter — the reported bug), param-predicated
 * materials (wavy boil) engage only when their knob does, and clock-free
 * paints stay false so static decks don't spin a rAF loop for nothing.
 *
 * Run: node tests/animated_paint_test.js
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paintIsAnimated, materialIds, getMaterial } from "../render_gpu/skia/materials.js";
import { strokeMaterialIds, getStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const mk = (id, params = {}) => ({ type: "material", material: { id, params } });

// The reported bug, pinned forever: rainy_window IS animated as a paint.
ok(paintIsAnimated(mk("rainy_window")), "rainy_window paint is animated (the reported freeze)");
ok(paintIsAnimated(mk("glitch")), "glitch paint is animated");
ok(paintIsAnimated(mk("sky")), "sky paint is animated");
ok(paintIsAnimated(mk("raycast_dither")), "raycast_dither paint is animated");
ok(paintIsAnimated(mk("wavy", { boil: 2 })), "wavy with boil engaged is animated");
ok(!paintIsAnimated(mk("wavy", { boil: 0 })), "wavy with boil 0 is static");
ok(!paintIsAnimated(mk("wavy")), "wavy default (boil absent) is static");
ok(!paintIsAnimated(mk("metal")), "metal is static (analytic lighting, no clock)");
ok(!paintIsAnimated("#ff0000"), "a solid color is static");
ok(!paintIsAnimated({ type: "gradient", stops: [] }), "a gradient is static");
ok(!paintIsAnimated(null) && !paintIsAnimated(undefined), "null/undefined paints are static");

// COMPLETENESS SWEEP: any material file whose SHADER SOURCE references the
// particleTime import must declare `animated` on its registry entry — a
// time-reading material without the flag reproduces the rainy freeze silently.
// (particle clock imports for non-shading purposes would need an allowlist
// entry here; today there are none.)
const SKIA_DIR = resolve(HERE, "../render_gpu/skia");
const CLOCK_FILES = readdirSync(SKIA_DIR)
  .filter((f) => f.endsWith(".js"))
  .filter((f) => readFileSync(resolve(SKIA_DIR, f), "utf8").includes('from "../particle_clock.js"'));
// Files that read the clock but are not material DEFINITION files (painter,
// preset data, stroke registry checked separately below).
const NON_DEF = new Set(["paint_skia.js", "material_presets.js", "stroke_materials.js"]);
const defFiles = CLOCK_FILES.filter((f) => !NON_DEF.has(f));
const flagged = new Set(
  [...materialIds().map((id) => [id, getMaterial(id)]), ...strokeMaterialIds().map((id) => [id, getStrokeMaterial(id)])]
    .filter(([, e]) => e.animated !== undefined)
    .map(([id]) => id)
);
for (const f of defFiles) {
  const src = readFileSync(resolve(SKIA_DIR, f), "utf8");
  const declares = /animated:/.test(src);
  ok(declares, `${f} imports particle_clock AND declares animated on its entry`);
}
ok(flagged.has("wavy"), "stroke registry carries wavy's boil predicate");
console.log(`  info clock-reading definition files swept: ${defFiles.join(", ")} | flagged entries: ${[...flagged].join(", ")}`);

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS — animated-paint detection (presenter repaint-loop seam)");
