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
import { fancyArrowPlugin } from "./fancy_arrow.js";
import { elbowArrowPlugin } from "./elbow_arrow.js";
import { curvedArrowPlugin } from "./curved_arrow.js";
import { imagePlugin } from "./image.js";
import { videoPlugin } from "./video.js";
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
import { shapeshifterPlugins } from "./shapeshifter.js";
// DEMO widgets (plugins/demo/) — showcase the extensibility story (custom
// self.* properties). Surfaced via the "Insert Demo Widget" submenu (App.svelte),
// not the core Add menus.
import { demoShowcasePlugin } from "./demo/showcase.js";
import { glassPlugin } from "./demo/glass.js";
import { cursorPlugin } from "./demo/cursor.js";
import { crtPlugin } from "./demo/crt.js";
import { magnifyPlugin } from "./demo/magnify.js"; // sampler-family lens: circle / square / star silhouettes
import { textMorphPlugins } from "./demo/text_morph.js"; // dissolve / typewriter / scramble
import { corkboardPlugins } from "./demo/corkboard.js"; // board / note / thumbtack / yarn (foreground materials)
import { raycastDitherPlugin } from "./demo/raycast_dither.js"; // animated grain mesh-gradient (generative foreground material)

export const allPlugins = [rectPlugin, shapePlugin, svgPlugin, circlePlugin, textPlugin, arrowPlugin, linePlugin, fancyArrowPlugin, elbowArrowPlugin, curvedArrowPlugin, imagePlugin, videoPlugin, filmstripPlugin, magnifierPlugin, blurPlugin, cameraPlugin, cropboxPlugin, donutPlugin, groupPlugin, codeblockPlugin, anchorPointPlugin, pdfPagePlugin, particlesPlugin, latexPlugin, mermaidPlugin, qrcodePlugin, plaintextPlugin, numberPlugin, bentoPlugin, clockDigitalPlugin, ...shapeshifterPlugins, demoShowcasePlugin, glassPlugin, cursorPlugin, crtPlugin, magnifyPlugin, ...textMorphPlugins, ...corkboardPlugins, raycastDitherPlugin];

/** Command. Registers every plugin and its palette commands. */
export function registerAll(registry, commands) {
  for (const plugin of allPlugins) {
    registry.register(plugin);
    for (const cmd of plugin.commands ?? []) commands.add(cmd);
  }
}
