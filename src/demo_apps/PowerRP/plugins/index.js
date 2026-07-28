/**
 * The V1 plugin roster. Registering a widget type is ONE line here (plus its
 * file) — nothing else in the app knows concrete types.
 */

import { rectPlugin } from "./rect.js";
import { shapePlugin } from "./shape.js";
import { svgPlugin } from "./svg.js";
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
import { donutPlugin } from "./donut.js";
import { groupPlugin } from "./group.js";
import { codeblockPlugin } from "./codeblock.js";
import { anchorPointPlugin } from "./anchor_point.js";
import { pdfPagePlugin } from "./pdf_page.js";
import { particlesPlugin } from "./particles.js";
import { latexPlugin } from "./latex.js";
import { mermaidPlugin } from "./mermaid.js";
import { qrcodePlugin } from "./qrcode.js";
import { plaintextPlugin } from "./plaintext.js";
import { clockDigitalPlugin } from "./clock_digital.js";
import { numberPlugin } from "./number.js";
import { bentoPlugin } from "./bento.js";
import { progressBarPlugin } from "./progress_bar.js"; // track+fill two-box bar; fraction is equation-bindable (e.g. = a video scrubber's progress export)
import { clockAnalogPlugin } from "./clock_analog.js";
import { shapeshifterPlugins } from "./shapeshifter.js";
import { polygonPlugin } from "./polygon.js"; // freeform polygon/polyline: a variable-length vertex list, every vertex a handle, the whole list one keyframable leaf
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
import { videoV2Plugin } from "./demo/video_v2.js"; // V2 video player: CanvasKit makeImageFromTextureSource DIRECT GPU upload (own element registry + videoV2 op)
import { videoV5Plugin } from "./demo/video_v5.js"; // Video V5: off-main-thread frame pipeline (worker createImageBitmap → cheap GPU upload) — A/B vs the core video widget
import { videoV5ScrubPlugin } from "./demo/video_v5_scrub.js"; // Video V5 SCRUBBER: video_scrub.js deterministic scrubTime UX driven through the V5 off-main-thread scrub decoder (videoV5Frame op) — A/B vs the core scrubber
import { videoV6Plugin } from "./demo/video_v6.js"; // fresh video player — live frame drawn by a shared WebGPU external-texture overlay (web/VideoV6Overlay), Skia backing rect
import { videoV7Plugin } from "./demo/video_v7.js"; // video PLAYER via a PER-WIDGET WebGPU overlay canvas (2D drawImage fallback on plain HTTP) — rendered OUTSIDE the Skia scene (web/VideoV7Overlay.svelte)
import { videoV8Plugin } from "./demo/video_v8.js"; // fresh video-player: ONE overlay canvas over Skia, WebGPU zero-copy OR WebGL2 upload backend (cohort V8)
import { comicPlugin } from "./demo/comic.js"; // comic-book Ben-Day halftone filter (backdrop material + presets)
import { glitchPlugin } from "./demo/glitch.js"; // animated sci-fi datamosh / broken-signal glitch (backdrop material + presets)
import { mandelbrotPlugin } from "./demo/mandelbrot.js"; // deep-zoom Mandelbrot (perturbation + rebasing in SkSL; split-number centre so every property keyframes)
import { brightnessContrastPlugin } from "./demo/brightness_contrast.js"; // tone-adjustment region filter (non-clipping logistic-gain contrast / linear-light exposure / naive sRGB + hue lock)

export const allPlugins = [rectPlugin, shapePlugin, svgPlugin, circlePlugin, textPlugin, arrowPlugin, linePlugin, tangentLinesPlugin, fancyArrowPlugin, elbowArrowPlugin, curvedArrowPlugin, imagePlugin, videoPlugin, videoScrubPlugin, filmstripPlugin, magnifierPlugin, blurPlugin, cameraPlugin, cropboxPlugin, donutPlugin, groupPlugin, codeblockPlugin, anchorPointPlugin, pdfPagePlugin, particlesPlugin, latexPlugin, mermaidPlugin, qrcodePlugin, plaintextPlugin, numberPlugin, bentoPlugin, progressBarPlugin, clockDigitalPlugin, clockAnalogPlugin, ...shapeshifterPlugins, polygonPlugin, demoShowcasePlugin, glassPlugin, frostedGlassPlugin, cursorPlugin, crtPlugin, metaballsPlugin, magnifyPlugin, ...textMorphPlugins, ...corkboardPlugins, raycastDitherPlugin, rainyWindowPlugin, ...skyPlugins, lensFlarePlugin, videoV2Plugin, videoV5Plugin, videoV5ScrubPlugin, videoV6Plugin, videoV7Plugin, videoV8Plugin, comicPlugin, glitchPlugin, mandelbrotPlugin, brightnessContrastPlugin];

/** Command. Registers every plugin and its palette commands. */
export function registerAll(registry, commands) {
  for (const plugin of allPlugins) {
    registry.register(plugin);
    for (const cmd of plugin.commands ?? []) commands.add(cmd);
  }
}
