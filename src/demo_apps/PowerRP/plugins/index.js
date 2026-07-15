/**
 * The V1 plugin roster. Registering a widget type is ONE line here (plus its
 * file) — nothing else in the app knows concrete types.
 */

import { rectPlugin } from "./rect.js";
import { circlePlugin } from "./circle.js";
import { textPlugin } from "./text.js";
import { arrowPlugin } from "./arrow.js";
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

export const allPlugins = [rectPlugin, circlePlugin, textPlugin, arrowPlugin, fancyArrowPlugin, elbowArrowPlugin, curvedArrowPlugin, imagePlugin, videoPlugin, filmstripPlugin, magnifierPlugin, blurPlugin, cameraPlugin, cropboxPlugin, donutPlugin, groupPlugin, codeblockPlugin, anchorPointPlugin, pdfPagePlugin];

/** Command. Registers every plugin and its palette commands. */
export function registerAll(registry, commands) {
  for (const plugin of allPlugins) {
    registry.register(plugin);
    for (const cmd of plugin.commands ?? []) commands.add(cmd);
  }
}
