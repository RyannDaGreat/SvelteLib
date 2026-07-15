/**
 * The V1 plugin roster. Registering a widget type is ONE line here (plus its
 * file) — nothing else in the app knows concrete types.
 */

import { rectPlugin } from "./rect.js";
import { circlePlugin } from "./circle.js";
import { textPlugin } from "./text.js";
import { arrowPlugin } from "./arrow.js";
import { fancyArrowPlugin } from "./fancy_arrow.js";
import { magnifierPlugin } from "./magnifier.js";
import { blurPlugin } from "./blur.js";
import { cameraPlugin } from "./camera.js";

export const allPlugins = [rectPlugin, circlePlugin, textPlugin, arrowPlugin, fancyArrowPlugin, magnifierPlugin, blurPlugin, cameraPlugin];

/** Command. Registers every plugin and its palette commands. */
export function registerAll(registry, commands) {
  for (const plugin of allPlugins) {
    registry.register(plugin);
    for (const cmd of plugin.commands ?? []) commands.add(cmd);
  }
}
