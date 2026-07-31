/**
 * SVG/ICONIFY FILL-OVERRIDE × STROKE-MATERIAL probe (browser) — the crash gate.
 *
 * THE LIVE BUG THIS PINS. Choosing fill material "crt" on an iconify icon threw
 *
 *   Uncaught Error: stroke_materials.getStrokeMaterial: unknown stroke material
 *   "crt" (known: alongGradient, widthProfile, dashes, wavy, brush, textureBrush)
 *
 * EVERY FRAME, and the canvas died. Cause: the SVG fill override is a MONOCHROME
 * TINT — one paint lands in the fill AND stroke slot of every flattened op, which
 * it must, because half the icon sets (tabler, lucide, mdi outline) are authored
 * `fill="none" stroke="currentColor"` and a fill-only override would leave them
 * visibly untouched. But fill materials and STROKE materials are two registries
 * with DISJOINT rosters, and each painter looks up only its own — paint_skia's
 * drawMaterialStroke calls getStrokeMaterial, its fill twin calls getMaterial,
 * both unconditionally. So on exactly the icons the override exists to serve, a
 * fill-only material reached a slot that cannot paint it.
 *
 * THE ASYMMETRY RUNS BOTH WAYS, and THIS PROBE IS WHAT PROVED IT. The first fix
 * guarded only the stroke slot; the `wavy` control below — a stroke-only material,
 * added merely to show the pass-through path still worked — died on
 * `getMaterial: unknown material "wavy"` in the FILL slot. Hence the rule the
 * probe now pins in both directions: EACH SLOT ASKS ITS OWN REGISTRY.
 *
 * WHY A BROWSER PROBE and not just the node emit test (tests/paint_off_test.js
 * section E, which pins the display list). The node test proves the OPS are right.
 * It cannot prove the PAINTER survives them: the throw happened downstream of the
 * display list, inside Skia paint, on a real GPU surface. Only rendering an actual
 * frame and watching for an uncaught error checks the thing that actually broke.
 * A green node suite is exactly what we had while the canvas was dead.
 *
 * WHAT IT ASSERTS, per case, against a no-override baseline:
 *   ZERO PAGEERRORS  — the crash itself. Any uncaught error fails the probe.
 *   OUTLINE PAINTED  — the stroked icon's ink DIFFERS from baseline, i.e. the
 *                      substitution painted something rather than silently
 *                      dropping the stroke (a "safe" no-op would look like a fix
 *                      and be an invisible icon).
 *   FILL KEEPS THE MATERIAL — the filled shape's interior differs from BOTH the
 *                      baseline AND the flat-solid render, proving the fill slot
 *                      still got the material and was not degraded along with the
 *                      stroke.
 * The stroke-only control (wavy) asserts the exact mirror: its OUTLINE keeps the
 * material while its FILL matches the flat-solid render pixel for pixel.
 *
 * THE FLAT-SOLID REFERENCE IS A TAGGED PAINT, deliberately. A bare "#ff00ff"
 * string does not survive the widget's paint evaluation, so it renders identical
 * to the baseline — which would make every "differs from solid" assertion here
 * vacuously true. That is a live trap: the first draft of this probe used one.
 *
 * Screenshot lands in .claude_vlm_checks/svg_stroke_material_<case>.png.
 *
 * Spawns its own Vite + headless Chromium (the material_fill_probe pattern),
 * renders through the SAME __powerrp_render seam the CLI uses (?cli=1).
 * Frontend-only. Run:
 *   node src/demo_apps/PowerRP/tests/svg_stroke_material_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { hasStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 480, H = 240;
const BG = "#f4f4f8";

/** THE FILL-ONLY MATERIAL the user actually picked. Asserted (not assumed) to be
 *  absent from the stroke registry, since that absence IS the bug's premise. */
const FILL_ONLY_MATERIAL = "crt";
/** A STROKE-capable material, to prove the pass-through path still works. */
const STROKE_CAPABLE_MATERIAL = "wavy";
/** The material paint's solid fallback — what a stroke slot must degrade TO, and
 *  a colour nothing else in the scene uses so a sample can attribute it. */
const FALLBACK_SOLID = "#ff00ff";

/** An OUTLINE icon in the tabler/lucide authoring (`fill="none"
 *  stroke="currentColor"`) — the case where the override lands ONLY in stroke
 *  slots, which is what made this the common path rather than a corner. Drawn
 *  thick so a stroke sample lands well clear of antialiasing. */
const OUTLINE_SVG = `<svg viewBox="0 0 24 24"><path d="M2 12 L22 12" fill="none" stroke="currentColor" stroke-width="6"/></svg>`;
/** A FILLED shape, so the same frame also shows the fill slot keeping the material. */
const FILLED_SVG = `<svg viewBox="0 0 24 24"><rect x="0" y="0" width="24" height="24" fill="#00aa44"/></svg>`;

const OUTLINE_AT = { x: 30, y: 60 }, FILLED_AT = { x: 270, y: 60 }, BOX = 180;
/** Sample points, box-local. The outline's stroke is the horizontal band across
 *  its middle; the filled shape's interior is anywhere well inside. */
const OUTLINE_SAMPLE = [BOX / 2, BOX / 2];
const FILLED_SAMPLE = [BOX / 2, BOX / 2];

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * Near-pure (fresh ids). One document: the outline icon + the filled shape, both
 * svg widgets, under `fill` — a paint, or null for the no-override baseline.
 */
function probeDoc(fillPaint) {
  let doc = newDocument(), z = 1;
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  const add = (over) => { [doc] = withNewItem(doc, 0, { ...registry.get("svg").defaults, ...over, active: true, z: z++ }); };
  const fill = fillPaint === null ? registry.get("svg").defaults.fill : fillPaint;
  add({ x: OUTLINE_AT.x, y: OUTLINE_AT.y, w: BOX, h: BOX, svgSrc: OUTLINE_SVG, preserveAspect: false, strokeWidth: 0, fill });
  add({ x: FILLED_AT.x, y: FILLED_AT.y, w: BOX, h: BOX, svgSrc: FILLED_SVG, preserveAspect: false, strokeWidth: 0, fill });
  return serialize(doc);
}

/** A material paint carrying the solid fallback a non-stroke-capable material
 *  must degrade to in a stroke slot. */
const materialPaint = (id) => ({ type: "material", material: { id, params: {} }, solid: FALLBACK_SOLID });

/** Pure function. Mean absolute RGB difference between two decoded PNGs at one
 * pixel. @example pixelDiff(png, png, 0, 0) // 0 (a PNG against itself) */
function pixelDiff(a, b, x, y) {
  const i = (y * a.width + x) * 4;
  return (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
}

/** Per-channel tolerance for "same as" and the minimum mean-abs difference for
 *  "this painted something". Mirrors material_fill_probe's thresholds. */
const SAME_TOL = 3;
const DIFF_MIN = 4;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };

try {
  const page = await browser.newPage();
  /** Uncaught page errors, collected per render so a case can be attributed. */
  let pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_render, { timeout: 40000 });

  /** Renders one document and hands back the PNG plus any errors it threw. */
  const render = async (docJson) => {
    pageErrors = [];
    const dataUrl = await page.evaluate(
      (json, w, h) => window.__powerrp_render(json, { slide: 0, width: w, height: h }),
      docJson, W, H,
    );
    return { png: readPng(Buffer.from(dataUrl.split(",")[1], "base64")), errors: [...pageErrors] };
  };

  // The premise: crt really is fill-only. If a future round makes it stroke-capable
  // this probe must be re-aimed, not silently pass on a vacuous case.
  ok(!hasStrokeMaterial(FILL_ONLY_MATERIAL), `${FILL_ONLY_MATERIAL} is fill-only — the premise of this probe`);
  ok(hasStrokeMaterial(STROKE_CAPABLE_MATERIAL), `${STROKE_CAPABLE_MATERIAL} IS stroke-capable — the control`);

  // BASELINE: the override OFF, so the artwork keeps its own paints.
  const base = await render(probeDoc(null));
  ok(base.errors.length === 0, `baseline (override OFF) renders with ZERO uncaught errors${base.errors.length ? `: ${base.errors[0]}` : ""}`);
  fs.writeFileSync(resolve(SHOTS, "svg_stroke_material_baseline.png"), PNG.sync.write(base.png));

  // A FLAT SOLID override, to separate "the fill kept the material" from "the fill
  // changed at all" — the material render must differ from this too.
  // TAGGED, not the bare string: a bare-string fill does not survive the widget's
  // paint evaluation the way a tagged paint does, and an override that silently did
  // not apply would make every "differs from solid" assertion below vacuously true.
  const solid = await render(probeDoc({ type: "solid", solid: FALLBACK_SOLID }));
  ok(solid.errors.length === 0, `a SOLID override renders with ZERO uncaught errors${solid.errors.length ? `: ${solid.errors[0]}` : ""}`);
  fs.writeFileSync(resolve(SHOTS, "svg_stroke_material_solid.png"), PNG.sync.write(solid.png));

  // ── THE CRASH CASE ─────────────────────────────────────────────────────────
  {
    const { png, errors } = await render(probeDoc(materialPaint(FILL_ONLY_MATERIAL)));
    fs.writeFileSync(resolve(SHOTS, `svg_stroke_material_${FILL_ONLY_MATERIAL}.png`), PNG.sync.write(png));

    // (1) THE BUG ITSELF. Before the fix this list held the getStrokeMaterial throw.
    ok(errors.length === 0, `${FILL_ONLY_MATERIAL} override: ZERO uncaught errors${errors.length ? ` — got ${JSON.stringify(errors[0])}` : ""}`);
    ok(!errors.some((e) => /getStrokeMaterial/.test(e)), `${FILL_ONLY_MATERIAL} override: no getStrokeMaterial throw specifically`);

    // (2) The OUTLINE icon still has ink — the substitution painted, it did not
    // quietly drop the stroke (which would look like a fix and render nothing).
    const outlineDiff = pixelDiff(png, base.png, OUTLINE_AT.x + OUTLINE_SAMPLE[0], OUTLINE_AT.y + OUTLINE_SAMPLE[1]);
    ok(outlineDiff >= DIFF_MIN, `${FILL_ONLY_MATERIAL} override: the OUTLINE's stroke was RECOLOURED, not dropped (diff ${outlineDiff.toFixed(1)} >= ${DIFF_MIN})`);

    // (3) The FILL slot kept the material: its interior differs from the baseline
    // AND from the flat solid, so it was not degraded along with the stroke.
    const fx = FILLED_AT.x + FILLED_SAMPLE[0], fy = FILLED_AT.y + FILLED_SAMPLE[1];
    const vsBase = pixelDiff(png, base.png, fx, fy);
    const vsSolid = pixelDiff(png, solid.png, fx, fy);
    ok(vsBase >= DIFF_MIN, `${FILL_ONLY_MATERIAL} override: the FILL was painted (diff vs baseline ${vsBase.toFixed(1)} >= ${DIFF_MIN})`);
    ok(vsSolid >= DIFF_MIN, `${FILL_ONLY_MATERIAL} override: the FILL kept the MATERIAL, not the solid fallback (diff vs flat solid ${vsSolid.toFixed(1)} >= ${DIFF_MIN})`);
  }

  // ── THE CONTROL: a stroke-capable material must be untouched by the fix ─────
  {
    const { png, errors } = await render(probeDoc(materialPaint(STROKE_CAPABLE_MATERIAL)));
    fs.writeFileSync(resolve(SHOTS, `svg_stroke_material_${STROKE_CAPABLE_MATERIAL}.png`), PNG.sync.write(png));
    ok(errors.length === 0, `${STROKE_CAPABLE_MATERIAL} override: ZERO uncaught errors${errors.length ? ` — got ${JSON.stringify(errors[0])}` : ""}`);
    const outlineDiff = pixelDiff(png, base.png, OUTLINE_AT.x + OUTLINE_SAMPLE[0], OUTLINE_AT.y + OUTLINE_SAMPLE[1]);
    ok(outlineDiff >= DIFF_MIN, `${STROKE_CAPABLE_MATERIAL} override: the stroke material PAINTED the outline (diff ${outlineDiff.toFixed(1)} >= ${DIFF_MIN})`);
    // THE MIRROR IMAGE, and the reason this control exists: wavy is stroke-only, so
    // the FILL slot must have degraded to the solid rather than throwing getMaterial.
    // This case is what caught the one-directional first fix.
    const fx = FILLED_AT.x + FILLED_SAMPLE[0], fy = FILLED_AT.y + FILLED_SAMPLE[1];
    const vsSolid = pixelDiff(png, solid.png, fx, fy);
    ok(vsSolid <= SAME_TOL, `${STROKE_CAPABLE_MATERIAL} override: the FILL degraded to the solid fallback (diff vs flat solid ${vsSolid.toFixed(1)} <= ${SAME_TOL})`);
  }

  // ── OFF IS STILL BYTE-IDENTICAL (the fix perturbed no existing pixel) ───────
  {
    const again = await render(probeDoc(null));
    let maxDiff = 0;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) maxDiff = Math.max(maxDiff, pixelDiff(again.png, base.png, x, y));
    ok(maxDiff <= SAME_TOL, `override OFF renders identically to the baseline (max sampled diff ${maxDiff.toFixed(1)} <= ${SAME_TOL})`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll svg/iconify stroke-material checks passed.");
