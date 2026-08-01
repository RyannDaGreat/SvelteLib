/**
 * The V1 plugin roster. Registering a widget type is ONE line here (plus its
 * file) — nothing else in the app knows concrete types.
 *
 * ── THE ROSTER NOW HAS TWO HALVES ─────────────────────────────────────────────
 * `allPlugins` below is the SOURCE-MODULE half. The second half is the BUILT-IN
 * PLUGIN-ASSET LIBRARY (assets/builtin/library/): tier-1 pure-vector widgets that
 * ship with the app but are delivered as `*.plugin.js` ASSETS and registered
 * through the sandbox — core/builtin_plugin_assets.js explains why, and which
 * five moved. registerPlugins() below loads both, so every consumer of "the
 * built-in roster" (the editor, the render-job page, cli/render.js and every node
 * suite) gets the same set with no call-site change.
 */

import { createRegistry } from "../core/registry.js"; // builtinRoster() needs one to evaluate the library through the jail
import { registerBuiltinPluginAssets } from "../core/builtin_plugin_assets.js"; // the BUILT-IN plugin-asset library (assets/builtin/library/) — the roster's second half
import { builtinAssetCommands } from "./builtin_asset_commands.js"; // their palette entries (a plugin ASSET may not declare `commands`)
import { rectPlugin } from "./rect.js";
import { shapePlugin } from "./shape.js";
import { svgPlugin } from "./svg.js";
import { iconifyPlugin } from "./iconify.js"; // the whole Iconify catalog as a widget: icon id → API URL → the shared SVG flatten (search palette in the canvas toolbar)
import { circlePlugin } from "./circle.js";
import { textPlugin } from "./text.js";
import { arrowPlugin } from "./arrow.js";
import { linePlugin } from "./line.js"; // arrow-family: a straight stroke, no head
import { tangentLinesPlugin } from "./tangent_lines.js"; // two external tangents between two shapes (zoom-callout bridge)
import { fancyArrowPlugin } from "./fancy_arrow.js";
import { elbowArrowPlugin } from "./elbow_arrow.js";
import { curvedArrowPlugin } from "./curved_arrow.js";
import { imagePlugin } from "./image.js";
import { videoPlugin } from "./video.js";
import { videoScrubPlugin } from "./video_scrub.js";
import { filmstripPlugin } from "./filmstrip.js";
import { magnifierPlugin } from "./magnifier.js";
import { blurPlugin } from "./blur.js";
import { cameraPlugin } from "./camera.js";
import { cropboxPlugin } from "./cropbox.js";
import { groupPlugin } from "./group.js";
import { codeblockPlugin } from "./codeblock.js";
import { anchorPointPlugin } from "./anchor_point.js";
import { pdfPagePlugin } from "./pdf_page.js";
import { paperPeacockPlugin } from "./paper_peacock.js"; // a PDF's pages fanned like a peacock tail (the MotionV2V hero figure)
import { pdfPacketPlugin } from "./pdf_packet.js"; // a corner-stapled packet with physical page turns (fractional `page`)
import { particlesPlugin } from "./particles.js";
import { latexPlugin } from "./latex.js";
import { mermaidPlugin } from "./mermaid.js";
import { qrcodePlugin } from "./qrcode.js";
import { plaintextPlugin } from "./plaintext.js";
import { bentoPlugin } from "./bento.js";
import { shapeshifterPlugins } from "./shapeshifter.js";
import { polygonPlugin } from "./polygon.js"; // freeform polygon/polyline: a variable-length vertex list, every vertex a handle, the whole list one keyframable leaf
import { paintPathPlugin } from "./paint_path.js"; // paintable editable cubic-bezier stroke: mirrored-handle anchor list with BREAKS (multi-subpath) + the universal stroke-trim draw-on (strokeStart/End/phase/caps)
import { aperturePlugin } from "./aperture.js"; // camera iris diaphragm: the opening is the bore intersected with N blade regions, so wide-open is round and the polygon emerges on stopping down (blade/ray parity shared with the lens flare via core/optics.js)
// GRAPH family (items 63-66, 71): parametric-curve / ruler / grid / bars, all
// driven by the shared core scale + equation modules (core/graph_scale.js,
// core/graph_equation.js). Siblings of polygon (unbounded data), NOT shapeshifter.
import { graphLinePlugin } from "./graph_line.js"; // parametric curve: one Monaco equation sampled over [tStart,tEnd] → one path; STROKE_TRIM draw-in
import { graphTickMarksPlugin } from "./graph_tick_marks.js"; // matplotlib/Manim ruler: axes, ticks, labels, arrow tips
import { graphGridPlugin } from "./graph_grid.js"; // coordinate grid + faded sub-lines + geometry-baked snake-in (growth via the lagged-reveal formula)
import { graphBarsPlugin } from "./graph_bars.js"; // programmatic bar graph: direct/riemann/literal, the reveal grow-up, area-under-curve
// DEMO widgets (plugins/demo/) — showcase the extensibility story (custom
// self.* properties). Surfaced via the "Add Demo Widget" submenu (App.svelte),
// not the core Add menus.
import { demoShowcasePlugin } from "./demo/showcase.js";
import { glassPlugin } from "./demo/glass.js";
import { frostedGlassPlugin } from "./demo/frosted_glass.js"; // basic frosted-blur panel (backdrop material, no liquid-glass refraction/specular)
import { cursorPlugin } from "./demo/cursor.js";
import { crtPlugin } from "./demo/crt.js";
import { metaballsPlugin } from "./demo/metaballs.js"; // Blender-style metaballs merged into water droplets (backdrop material)
import { magnifyPlugin } from "./demo/magnify.js"; // sampler-family lens: circle / square / star silhouettes
import { textMorphPlugins } from "./demo/text_morph.js"; // dissolve / typewriter / scramble
import { corkboardPlugins } from "./demo/corkboard.js"; // board / note / thumbtack / yarn (foreground materials)
import { raycastDitherPlugin } from "./demo/raycast_dither.js"; // animated grain mesh-gradient (generative foreground material)
import { rainyWindowPlugin } from "./demo/rainy_window.js"; // animated rain-on-glass (backdrop refraction material)
import { skyPlugins } from "./demo/sky.js"; // sky / skySun / skyMoon / skyClouds — physically-based sky family that INTERACTS (derive-time sibling query)
import { lensFlarePlugin } from "./demo/lens_flare.js"; // physically-motivated lens flare (generative foreground material + presets)
import { godRaysPlugin } from "./demo/god_rays.js"; // screen-space god rays (backdrop material: the scene beneath is both light source and occluder)
import { videoV2Plugin } from "./demo/video_v2.js"; // V2 video player: CanvasKit makeImageFromTextureSource DIRECT GPU upload (own element registry + videoV2 op)
import { videoV5Plugin } from "./demo/video_v5.js"; // Video V5: off-main-thread frame pipeline (worker createImageBitmap → cheap GPU upload) — A/B vs the core video widget
import { videoV5ScrubPlugin } from "./demo/video_v5_scrub.js"; // Video V5 SCRUBBER: video_scrub.js deterministic scrubTime UX driven through the V5 off-main-thread scrub decoder (videoV5Frame op) — A/B vs the core scrubber
import { videoTimeScrubPlugin } from "./demo/video_time_scrub.js"; // Video TIME SCRUBBER: the core scrubber with scrubTime bound to clock presets (time % self.length) — a deterministic looping player, manifest item 72
import { videoV6Plugin } from "./demo/video_v6.js"; // fresh video player — live frame drawn by a shared WebGPU external-texture overlay (web/VideoV6Overlay), Skia backing rect
import { videoV7Plugin } from "./demo/video_v7.js"; // video PLAYER via a PER-WIDGET WebGPU overlay canvas (2D drawImage fallback on plain HTTP) — rendered OUTSIDE the Skia scene (web/VideoV7Overlay.svelte)
import { videoV8Plugin } from "./demo/video_v8.js"; // fresh video-player: ONE overlay canvas over Skia, WebGPU zero-copy OR WebGL2 upload backend (cohort V8)
import { comicPlugin } from "./demo/comic.js"; // comic-book Ben-Day halftone filter (backdrop material + presets)
import { glitchPlugin } from "./demo/glitch.js"; // animated sci-fi datamosh / broken-signal glitch (backdrop material + presets)
import { mandelbrotPlugin } from "./demo/mandelbrot.js"; // deep-zoom Mandelbrot (perturbation + rebasing in SkSL; split-number centre so every property keyframes)
import { globeMapPlugin } from "./demo/globe_map.js"; // slippy map + lit globe with atmosphere (Web Mercator tiles; lon/lat/zoom are plain keyframable properties)
import { brightnessContrastPlugin } from "./demo/brightness_contrast.js"; // tone-adjustment region filter (non-clipping logistic-gain contrast / linear-light exposure / naive sRGB + hue lock)
import { scene3dPlugins } from "./demo/scene3d.js"; // THE 3D VIEWPORT FAMILY: scene3d_splat (Gaussian splats, working) + scene3d_model (glTF, loader not wired) — camera pose is keyframable property state, double-click flies it

export const allPlugins = [rectPlugin, shapePlugin, svgPlugin, iconifyPlugin, circlePlugin, textPlugin, arrowPlugin, linePlugin, tangentLinesPlugin, fancyArrowPlugin, elbowArrowPlugin, curvedArrowPlugin, imagePlugin, videoPlugin, videoScrubPlugin, filmstripPlugin, magnifierPlugin, blurPlugin, cameraPlugin, cropboxPlugin, groupPlugin, codeblockPlugin, anchorPointPlugin, pdfPagePlugin, paperPeacockPlugin, pdfPacketPlugin, particlesPlugin, latexPlugin, mermaidPlugin, qrcodePlugin, plaintextPlugin, bentoPlugin, ...shapeshifterPlugins, polygonPlugin, paintPathPlugin, aperturePlugin, graphLinePlugin, graphTickMarksPlugin, graphGridPlugin, graphBarsPlugin, demoShowcasePlugin, glassPlugin, frostedGlassPlugin, cursorPlugin, crtPlugin, metaballsPlugin, magnifyPlugin, ...textMorphPlugins, ...corkboardPlugins, raycastDitherPlugin, rainyWindowPlugin, ...skyPlugins, lensFlarePlugin, godRaysPlugin, videoV2Plugin, videoV5Plugin, videoV5ScrubPlugin, videoTimeScrubPlugin, videoV6Plugin, videoV7Plugin, videoV8Plugin, comicPlugin, glitchPlugin, mandelbrotPlugin, globeMapPlugin, brightnessContrastPlugin, ...scene3dPlugins];

/**
 * Command. Registers every plugin TYPE into `registry`, and nothing else.
 *
 * SPLIT OUT FROM registerAll BECAUSE THE TWO REGISTRIES HAVE DIFFERENT LIFETIMES,
 * which a bug made explicit: a PLUGIN registry is per-project (a `*.plugin.js`
 * project asset defines a widget type — core/plugin_assets.js), so opening a
 * project REBUILDS it, while palette COMMANDS are process-lifetime and are added
 * once at construction. Calling registerAll a second time to rebuild the types
 * therefore re-added every command and threw `Duplicate command id "add-rect"`,
 * making the editor unopenable on the second project open. This is the entry point
 * for "give me the built-in types again"; it cannot touch commands, so it cannot
 * reintroduce that failure.
 *
 * BOTH HALVES OF THE ROSTER: the source modules in `allPlugins`, then the BUILT-IN
 * PLUGIN-ASSET LIBRARY through the jail (core/builtin_plugin_assets.js). Source
 * modules go FIRST so their types are already taken when the library registers —
 * a library file whose `type` collides with a source plugin is then REFUSED with a
 * message naming the file, rather than silently shadowing a shipped widget.
 *
 * A LIBRARY REFUSAL IS REPORTED, NOT THROWN, and that asymmetry is deliberate:
 * `registry.register` throws on a bad source plugin because that is a build error
 * the developer must fix, while one unloadable library file must not make the
 * editor unopenable — the other four widgets, and every document using them, are
 * still fine. But it is never SILENT: a widget that failed to register is
 * indistinguishable to the user from one that was deleted, and repair DROPS its
 * items as orphans, so the failure is printed here with the file named.
 *
 * @param {object} registry - a core/registry.js registry
 * @returns {void}
 *
 * @example // registerPlugins(createRegistry())  → every built-in type registered
 */
export function registerPlugins(registry) {
  for (const plugin of allPlugins) registry.register(plugin);
  const { reports } = registerBuiltinPluginAssets(registry);
  for (const report of reports)
    console.error(`PowerRP built-in widget library REFUSED a widget — ${report}`);
}

/**
 * Query (evaluates the built-in library through the jail; memoized downstream).
 * THE WHOLE BUILT-IN ROSTER as plugin OBJECTS — `allPlugins` PLUS the built-in
 * plugin-asset library, in registration order.
 *
 * ── WHY THIS EXISTS: A SWEEP THAT SILENTLY SHRANK ────────────────────────────
 * About a dozen node suites are PROTOCOL SWEEPS: they iterate "every shipped
 * widget" and assert a protocol holds for each one (handle constraints, row
 * kinds, activation handlers, numeric steps, angle wrapping, effects
 * composition, list migration). Every one of them iterated `allPlugins`, which
 * was the same thing as "the roster" right up until the batch-1 migration moved
 * five widgets to the plugin-asset library. At that moment the sweeps quietly
 * stopped covering donut, progress_bar, number and both clocks — five widgets
 * dropped out of eleven protocol checks with no failure anywhere, because
 * "iterate a shorter list" is not an error.
 *
 * Exactly ONE assertion caught it: tests/handle_constraints_test.js names the
 * types its sweep MUST reach (`assert.ok(types.has("donut"))`), so the list
 * shrinking was a hard failure instead of a coverage hole. That is the lesson
 * worth keeping — a sweep over a list needs a floor, or it can pass by covering
 * nothing — and this function is the fix for the other ten.
 *
 * A SWEEP MUST USE THIS, NOT `allPlugins`. `allPlugins` still exists and is
 * still correct for its one real job: it is the SOURCE-MODULE half, the list
 * whose `commands` registerAll walks (a plugin asset may not declare any) and
 * whose objects are imported by identity. Anything asking "what widgets does
 * this app ship?" wants this function.
 *
 * WHY IT BUILDS A REGISTRY rather than concatenating: the library's plugins do
 * not exist as objects until the jail has evaluated them, and
 * registerBuiltinPluginAssets is the one path that does that with the collision
 * refusal and the drift report intact. Reusing it means a sweep sees precisely
 * the objects the editor registered — jailed hooks and all — rather than a
 * parallel construction that could disagree.
 *
 * @returns {object[]} every built-in plugin object, source modules first
 *
 * @example // builtinRoster().length > allPlugins.length   // true
 * @example // builtinRoster().map((p) => p.type).includes("donut")  // true (a LIBRARY widget)
 * @example // builtinRoster().map((p) => p.type).includes("rect")   // true (a SOURCE widget)
 */
export function builtinRoster() {
  const registry = createRegistry();
  registerPlugins(registry);
  return registry.all();
}

/** Command. Registers every plugin and its palette commands — the ONE-TIME boot
 *  path (app.svelte.js's constructor). To re-register only the TYPES (a project
 *  switch), call registerPlugins: adding the commands twice throws.
 *
 *  The built-in plugin-asset widgets' commands come from
 *  plugins/builtin_asset_commands.js, not from the plugin objects: a plugin ASSET
 *  may not declare `commands` at all (a command's run(app) receives the live app,
 *  the one capability the sandbox withholds), so their palette entries are declared
 *  separately and resolve their plugin lazily from the registry. */
export function registerAll(registry, commands) {
  registerPlugins(registry);
  for (const plugin of allPlugins)
    for (const cmd of plugin.commands ?? []) commands.add(cmd);
  for (const cmd of builtinAssetCommands) commands.add(cmd);
}
