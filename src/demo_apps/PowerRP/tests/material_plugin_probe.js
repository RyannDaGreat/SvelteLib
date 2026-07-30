/**
 * MATERIAL PLUGIN PROBE (browser) — the runtime half of the material-plugin
 * contract, in the real editor, on the real GPU (WebGL2 / swiftshader). The node
 * suite (tests/material_plugin_test.js) proves the DESCRIPTOR is byte-identical to
 * the shipped built-ins; this proves the PIXELS are real, which no amount of
 * deep-equal can. Five claims, each of which fails silently without a probe:
 *
 *   (1) THE MIGRATED GLASS PAINTS. A rect whose fill material is `glass` — now
 *       delivered as a plugin ASSET, not an imported descriptor — must produce a
 *       NON-UNIFORM readback. A shader that failed to compile, or a packer that
 *       mis-sized its uniform block, renders a flat region and exits 0.
 *   (2) IT IS THE PLUGIN, not a leftover built-in. The registry entry must carry
 *       `pluginSource`, so a green result cannot come from the descriptor this
 *       migration removed.
 *   (3) A COPY REGISTERS UNDER A DE-COLLIDED ID and is SELECTABLE — it appears in
 *       the same paint dropdown the built-ins do (fillCapableMaterialIds).
 *   (4) THE EDITED COPY RENDERS DIFFERENTLY, and the ORIGINAL IS UNTOUCHED. This is
 *       the user ruling's actual payoff ("the user could actually edit the shader
 *       inside the UI, and copy that built-in plugin into a new one"), and the one
 *       claim that a shared-descriptor bug would quietly break: an aliased copy
 *       repaints every glass fill in the document the moment one line changes.
 *   (5) IT GENERALIZES BEYOND GLASS. Every migrated material (glass, corkboard,
 *       rainy_window) is plugin-sourced, SELECTABLE in the paint dropdown, and paints
 *       a non-uniform region; and the edit-a-copy round trip is repeated on CORKBOARD
 *       — the most-knobbed migrated material (11 params) and a FOREGROUND one, so the
 *       edited shader reaches the GPU down materialFill rather than the backdrop path
 *       glass exercises. One material proves the mechanism; two prove the seam.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * glass_probe.js pattern. Frontend-only — backend-absent 404s are ignored.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_plugin_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

// THE EDIT: glass's luminance weights. Chosen because they are UNCONDITIONAL —
// `REC709` drives both the desaturation mix and the adaptive-tint decision, so it
// contributes at EVERY pixel under the DEFAULT knobs. That mattered: the first
// attempt edited ADAPT_FIXED, which the shader mixes by `uAdaptivity`, and the
// default `tintAdaptivity: 1` mixes it entirely OUT — a real edit to a real
// constant that is genuinely a no-op at default params, and the probe correctly
// measured Δ 0.0. An edit whose visibility depends on a non-default knob does not
// test "the edit reached the GPU"; this one cannot be cancelled by any knob.
const EDIT_FROM = "const half3 REC709 = half3(0.2126, 0.7152, 0.0722);";
const EDIT_TO = "const half3 REC709 = half3(0.9000, 0.0500, 0.0500);";
// Minimum mean per-channel difference for "these are visibly different shaders".
// MEASURED, not guessed: this exact edit yields Δ ≈ 4.3 at glass's DEFAULT knobs,
// because `saturation: 0.92` keeps 92% of the original colour and the luminance term
// only contributes the remaining 8% (plus the adaptive-tint neutral it selects). The
// threshold is set just under that, and comfortably above the ≤ 2-level
// rasterization wobble the manifest documents for region-bounded backdrop
// re-renders — so it separates "the edit reached the GPU" from "the raster jittered"
// without pretending the effect is larger than it is. The companion assertion below
// (the ORIGINAL's drift must stay under the SAME threshold) is what makes this a
// two-sided measurement rather than a lucky floor.
const EDIT_MIN_DELTA = 3;
// Minimum spread (max-min per channel) for "this region is not a flat fill".
const NON_UNIFORM_MIN = 12;

/** Absolute /@fs URL for a module inside the PowerRP tree. Vite's root is web/, so
 *  core/ and render_gpu/ sit OUTSIDE it and are only reachable this way — the
 *  browser_render_harness.js convention. */
const APP_DIR = resolve(HERE, "..");
const fsUrl = (relative) => `/@fs${APP_DIR}/${relative}`;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // `VideoV7: no WebGPU adapter` is ENVIRONMENTAL, not a failure: this probe runs on
  // swiftshader, which exposes no `navigator.gpu`, and the video path says so and
  // falls back by design. The Skia material pipeline this probe exercises is WebGL2
  // (render_gpu/skia/browser_surface.js), which is present — so ignoring this
  // message cannot hide a material problem.
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── (2) the registry entry is PLUGIN-SOURCED ───────────────────────────────
  const provenance = await page.evaluate(async (materialsUrl) => {
    const M = await import(/* @vite-ignore */ materialsUrl);
    const glass = M.getMaterial("glass");
    return {
      pluginSource: glass.pluginSource === true,
      isBuiltin: M.isBuiltinMaterialId("glass"),
      inPicker: M.fillCapableMaterialIds().includes("glass"),
      title: glass.title,
      uniformFloats: glass.uniformFloats,
      usesShapeSdf: glass.usesShapeSdf === true,
    };
  }, fsUrl("render_gpu/skia/materials.js"));
  assert(provenance.pluginSource, "glass is PLUGIN-sourced (a green paint cannot come from the removed built-in descriptor)");
  assert(!provenance.isBuiltin, "glass is no longer a BUILT-IN material id — it migrated to the asset library");
  assert(provenance.inPicker, "glass appears in the paint dropdown (fillCapableMaterialIds) beside the built-ins");
  assert(provenance.title === "Liquid Glass", `the dropdown label survived the migration (got ${JSON.stringify(provenance.title)})`);
  assert(provenance.uniformFloats === 25, `the declared uniform block derives 25 floats (got ${provenance.uniformFloats})`);
  assert(provenance.usesShapeSdf, "the shape-conforming fill variant came across");

  // ── (2b) EVERY migrated material is plugin-sourced AND in the picker ────────
  // The second wave (corkboard, rainy_window) rides the same path glass proved. This
  // asserts the LIST the paint dropdown actually renders, because the failure mode is
  // a material that registers fine but never becomes selectable — invisible to a
  // descriptor-level test, and the whole point of the user ruling.
  const MIGRATED = ["glass", "corkboard", "rainy_window"];
  const roster = await page.evaluate(async (materialsUrl, ids) => {
    const M = await import(/* @vite-ignore */ materialsUrl);
    const picker = M.fillCapableMaterialIds();
    return {
      picker,
      rows: ids.map((id) => {
        const m = M.getMaterial(id);
        return { id, pluginSource: m.pluginSource === true, isBuiltin: M.isBuiltinMaterialId(id), inPicker: picker.includes(id), title: m.title, floats: m.uniformFloats };
      }),
    };
  }, fsUrl("render_gpu/skia/materials.js"), MIGRATED);
  for (const row of roster.rows) {
    assert(row.pluginSource, `${row.id} is PLUGIN-sourced in the live registry`);
    assert(!row.isBuiltin, `${row.id} is no longer a built-in material id`);
    assert(row.inPicker, `${row.id} is SELECTABLE in the paint dropdown`);
    assert(typeof row.title === "string" && row.title.length > 0, `${row.id} carries a dropdown label (got ${JSON.stringify(row.title)})`);
  }
  console.log(`  info  paint dropdown lists ${roster.picker.length} fill materials: ${roster.picker.join(", ")}`);

  /**
   * Command (in-page). Injects a doc: camera + a colourful backdrop + ONE rect whose
   * FILL is the named material, renders it offscreen through the shared compositor,
   * and returns the readback stats over the panel's own region.
   */
  const renderMaterial = async (materialId) => page.evaluate(async (id) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type, active: true });
    const items = {
      cam: { ...def("camera"), name: "Camera", x: 0, y: 0, w: 960, h: 540, z: 1000, background: "#101018" },
      // A bright, high-frequency backdrop so a REFRACTING material has something to
      // bend — a glass panel over flat colour looks flat however correct it is.
      bar: { ...def("rect"), name: "Bar", x: 60, y: 200, w: 840, h: 90, z: 1, fill: "#ff3366", cornerRadius: 0 },
      c1: { ...def("circle"), name: "C1", x: 140, y: 90, w: 200, h: 200, z: 2, fill: "#22ddff" },
      c2: { ...def("circle"), name: "C2", x: 560, y: 260, w: 240, h: 240, z: 2, fill: "#ffee22" },
      panel: { ...def("rect"), name: "Panel", x: 260, y: 140, w: 440, h: 260, z: 50, cornerRadius: 0,
               fill: { type: "material", material: { id, params: {} } } },
    };
    const doc = { meta: { name: "material-plugin-qa", slideW: 960, slideH: 540 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    await new Promise((r) => setTimeout(r, 900)); // Skia paint + the RuntimeEffect compile
    const { renderCameraFrame } = await import("/gpuService.js");
    const W = 480, H = 270;
    // renderCameraFrame returns a CANVAS (not a data url), so the readback is a
    // direct getImageData — no decode round-trip.
    const frame = await renderCameraFrame(app.doc, { slideIndex: 0, alpha: 1, registry: app.registry, width: W, height: H });
    const cx = frame.getContext("2d");
    // Sample the PANEL's interior only: world (260,140,440x260) over a 960x540
    // camera, scaled into the W x H frame, inset by 10 world px so the readback
    // never straddles the panel's own antialiased rim.
    const sx = W / 960, sy = H / 540;
    const px = Array.from(cx.getImageData(
      Math.round(270 * sx), Math.round(150 * sy),
      Math.round(420 * sx), Math.round(240 * sy)).data);
    let rs = 0, gs = 0, bs = 0, n = 0;
    let rmin = 255, rmax = 0;
    for (let i = 0; i < px.length; i += 4) {
      rs += px[i]; gs += px[i + 1]; bs += px[i + 2]; n++;
      if (px[i] < rmin) rmin = px[i];
      if (px[i] > rmax) rmax = px[i];
    }
    return { mean: [rs / n, gs / n, bs / n], spread: rmax - rmin, samples: n };
  }, materialId);

  // ── (1) the migrated glass PAINTS ──────────────────────────────────────────
  const glassStats = await renderMaterial("glass");
  assert(glassStats.samples > 1000, `the panel region sampled real pixels (${glassStats.samples})`);
  assert(glassStats.spread >= NON_UNIFORM_MIN,
    `glass paints a NON-UNIFORM region (red spread ${glassStats.spread} >= ${NON_UNIFORM_MIN}) — a failed compile or a mis-packed uniform block would be flat`);
  await page.screenshot({ path: resolve(SHOTS, "material_plugin_glass.png") });

  // ── (1b) the SECOND-WAVE materials paint too ───────────────────────────────
  // Real SkSL, compiled by Skia from a jailed asset's string, on the real GPU. The
  // node suite can prove the uniforms are byte-identical and still not notice that a
  // shader never compiled — this is what closes that gap for corkboard (a FOREGROUND
  // material, so it exercises the materialFill path rather than the backdrop one) and
  // rainy_window (whose `fromClock` uniform must arrive as a finite number, or the
  // packer throws mid-composite).
  for (const id of ["corkboard", "rainy_window"]) {
    const stats = await renderMaterial(id);
    assert(stats.samples > 1000, `${id}: the panel region sampled real pixels (${stats.samples})`);
    assert(stats.spread >= NON_UNIFORM_MIN,
      `${id} paints a NON-UNIFORM region (red spread ${stats.spread} >= ${NON_UNIFORM_MIN}) — a failed compile renders flat and exits 0`);
    await page.screenshot({ path: resolve(SHOTS, `material_plugin_${id}.png`) });
  }

  // ── (3) a COPY registers under a de-collided id and is selectable ──────────
  const copy = await page.evaluate(async (edit) => {
    const PA = await import(/* @vite-ignore */ edit.pluginAssetsUrl);
    const BL = await import(/* @vite-ignore */ edit.builtinLibraryUrl);
    const M = await import(/* @vite-ignore */ edit.materialsUrl);
    const { sources } = BL.builtinPluginAssetSources();
    const glass = sources.find((s) => s.name === "liquid_glass.material.plugin.js");
    if (!glass) return { error: "the built-in library does not ship the glass material" };

    const copyId = PA.uniquePluginType("glass", M.materialIds());
    const plain = PA.retypedPluginSource(glass.source, copyId);
    const plainReports = PA.registerPluginAssets(window.__powerrp_app.registry, [{ name: "glass copy.material.plugin.js", source: plain }]).reports;

    // ── (4) EDIT the copy's shader, register the edited one ──────────────────
    const editedId = PA.uniquePluginType("glass", M.materialIds());
    // BOTH shaders carry the constant (`sksl` and the shape-conforming `fillSksl`),
    // and a shape FILL binds the second one — so a single-occurrence replace would
    // edit the shader this render never runs. Split/join replaces every occurrence.
    const editedText = glass.source.split(edit.from).join(edit.to);
    const editedSource = PA.retypedPluginSource(editedText, editedId);
    const editedReports = PA.registerPluginAssets(window.__powerrp_app.registry, [{ name: "glass edited.material.plugin.js", source: editedSource }]).reports;

    return {
      copyId, editedId, plainReports, editedReports,
      anchorCount: glass.source.split(edit.from).length - 1,
      copyInPicker: M.fillCapableMaterialIds().includes(copyId),
      editedInPicker: M.fillCapableMaterialIds().includes(editedId),
      editedHasNewShader: M.getMaterial(editedId).sksl.includes(edit.to),
      originalUntouched: M.getMaterial("glass").sksl.includes(edit.from),
      copyMatchesOriginal: M.getMaterial(copyId).sksl === M.getMaterial("glass").sksl,
    };
  }, {
    from: EDIT_FROM, to: EDIT_TO,
    pluginAssetsUrl: fsUrl("core/plugin_assets.js"),
    builtinLibraryUrl: fsUrl("core/builtin_plugin_assets.js"),
    materialsUrl: fsUrl("render_gpu/skia/materials.js"),
  });

  assert(!copy.error, copy.error ?? "the built-in library ships the glass material asset");
  assert(copy.anchorCount === 2, `the edit anchor exists in BOTH shipped shaders (found ${copy.anchorCount}, expected 2: sksl + fillSksl)`);
  assert(copy.copyId !== "glass" && /^glass_\d+$/.test(copy.copyId), `the copy took a DE-COLLIDED id (${copy.copyId})`);
  assert(copy.plainReports.length === 0, `the copy registered cleanly (${JSON.stringify(copy.plainReports)})`);
  assert(copy.copyInPicker, `the copy is SELECTABLE in the material picker (${copy.copyId})`);
  assert(copy.copyMatchesOriginal, "an UNEDITED copy starts as the same shader — editing it is the next step");
  assert(copy.editedReports.length === 0, `the EDITED copy registered cleanly (${JSON.stringify(copy.editedReports)})`);
  assert(copy.editedInPicker, `the edited copy is selectable too (${copy.editedId})`);
  assert(copy.editedHasNewShader, "the edited copy carries the NEW shader text");
  assert(copy.originalUntouched, "the ORIGINAL's shader text is untouched by the edit");

  // ── (4) the edited copy RENDERS differently; the original still renders the same ──
  const editedStats = await renderMaterial(copy.editedId);
  const glassAgain = await renderMaterial("glass");
  const meanDelta = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
  const editDelta = meanDelta(editedStats.mean, glassStats.mean);
  const originalDrift = meanDelta(glassAgain.mean, glassStats.mean);

  assert(editedStats.spread >= NON_UNIFORM_MIN, `the edited copy also paints a real region (spread ${editedStats.spread})`);
  assert(editDelta >= EDIT_MIN_DELTA,
    `the EDITED copy renders DIFFERENTLY from the original (Δ ${editDelta.toFixed(1)} >= ${EDIT_MIN_DELTA}) — the edit reached the GPU`);
  assert(originalDrift < EDIT_MIN_DELTA,
    `the ORIGINAL still renders the same after the copy+edit (drift ${originalDrift.toFixed(1)} < ${EDIT_MIN_DELTA}) — the copy did not alias it`);

  // ── (5) EDIT-A-COPY on a SECOND material, with the most knobs ──────────────
  // The user ruling is about editing ANY built-in shader, so proving it on one
  // material proves the mechanism but not that it generalizes. Corkboard is the right
  // second case: it has the most params of the migrated set (11), and it is a
  // FOREGROUND material, so the edited shader reaches the GPU down the materialFill
  // path rather than the backdrop one glass exercises.
  //
  // THE ANCHOR is the BASE TONE assignment — the line every other term modulates, so
  // it contributes at every pixel of the face under default knobs. Two weaker anchors
  // were MEASURED and rejected first, which is why this comment names the numbers
  // rather than asserting a rule: GRANULE_CONTRAST (the shader's own "dominant"
  // constant) gave Δ 0.6 because it modulates a zero-mean noise field that averages
  // out over a 25,200-px readback, and TOPLIGHT_GRAD gave Δ 2.8 because it is halved
  // and multiplied by a signed gradient that cancels across the panel. Both are real
  // edits that reach the GPU; neither separates cleanly from the rasterization wobble
  // at a threshold of 3. Swapping the base tone's channels cannot cancel or average.
  const CORK_EDIT_FROM = "half3 col = half3(uBaseColor);";
  const CORK_EDIT_TO = "half3 col = half3(uBaseColor.b, uBaseColor.r, uBaseColor.g);";
  const corkBefore = await renderMaterial("corkboard");
  const corkCopy = await page.evaluate(async (edit) => {
    const PA = await import(/* @vite-ignore */ edit.pluginAssetsUrl);
    const BL = await import(/* @vite-ignore */ edit.builtinLibraryUrl);
    const M = await import(/* @vite-ignore */ edit.materialsUrl);
    const { sources } = BL.builtinPluginAssetSources();
    const cork = sources.find((s) => s.name === "corkboard.material.plugin.js");
    if (!cork) return { error: "the built-in library does not ship the corkboard material" };
    const editedId = PA.uniquePluginType("corkboard", M.materialIds());
    const editedSource = PA.retypedPluginSource(cork.source.split(edit.from).join(edit.to), editedId);
    const reports = PA.registerPluginAssets(window.__powerrp_app.registry, [{ name: "cork edited.material.plugin.js", source: editedSource }]).reports;
    return {
      editedId, reports,
      anchorCount: cork.source.split(edit.from).length - 1,
      paramCount: M.getMaterial("corkboard").fillParams.length,
      inPicker: M.fillCapableMaterialIds().includes(editedId),
      originalUntouched: M.getMaterial("corkboard").sksl.includes(edit.from),
    };
  }, {
    from: CORK_EDIT_FROM, to: CORK_EDIT_TO,
    pluginAssetsUrl: fsUrl("core/plugin_assets.js"),
    builtinLibraryUrl: fsUrl("core/builtin_plugin_assets.js"),
    materialsUrl: fsUrl("render_gpu/skia/materials.js"),
  });

  assert(!corkCopy.error, corkCopy.error ?? "the built-in library ships the corkboard material asset");
  assert(corkCopy.paramCount === 11, `corkboard is the most-knobbed migrated material (${corkCopy.paramCount} params)`);
  assert(corkCopy.anchorCount === 2, `the cork edit anchor exists in BOTH shaders (found ${corkCopy.anchorCount})`);
  assert(corkCopy.reports.length === 0, `the edited cork copy registered cleanly (${JSON.stringify(corkCopy.reports)})`);
  assert(corkCopy.inPicker, `the edited cork copy is SELECTABLE (${corkCopy.editedId})`);
  assert(corkCopy.originalUntouched, "the ORIGINAL corkboard shader text is untouched by the edit");

  const corkEdited = await renderMaterial(corkCopy.editedId);
  const corkAgain = await renderMaterial("corkboard");
  const corkDelta = meanDelta(corkEdited.mean, corkBefore.mean);
  const corkDrift = meanDelta(corkAgain.mean, corkBefore.mean);
  assert(corkEdited.spread >= NON_UNIFORM_MIN, `the edited cork copy paints a real region (spread ${corkEdited.spread})`);
  assert(corkDelta >= EDIT_MIN_DELTA,
    `the EDITED corkboard renders DIFFERENTLY (Δ ${corkDelta.toFixed(1)} >= ${EDIT_MIN_DELTA}) — the edit reached the GPU`);
  assert(corkDrift < EDIT_MIN_DELTA,
    `the ORIGINAL corkboard is unchanged by the copy+edit (drift ${corkDrift.toFixed(1)} < ${EDIT_MIN_DELTA}) — two-sided, like glass`);

  if (errors.length) { fails.push(...errors); console.error("PAGE ERRORS:\n" + errors.join("\n")); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — material plugin probe`);
  process.exit(1);
}
console.log("\nPASS — material plugin probe (glass paints as a plugin; a copy registers, is selectable, and its edit reaches the GPU without touching the original)");
