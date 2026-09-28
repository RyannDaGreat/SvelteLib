/** Regenerate native-preset swatches with the actual shared final-quality painter.
 * Run from any directory: node src/demo_apps/PowerRP/cli/build_multipoint_thumbnails.mjs
 * Generated PNGs ship with the editor; no field solver runs just to open a menu. */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MULTIPOINT_PRESETS } from "../core/multipoint_presets.js";
import { rect } from "../render_gpu/ir.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";

const SWATCH_SIZE = 96; // exceeds the inspector's 64px swatch height on a 1x display
const OUTPUT = new URL("../web/multipoint_thumbnails/", import.meta.url);

/** Command. Renders every authored preset and replaces its shipped PNG thumbnail. */
async function main() {
  await mkdir(OUTPUT, {recursive:true});
  for (const preset of MULTIPOINT_PRESETS) {
    const commands = [rect({x:0,y:0,w:SWATCH_SIZE,h:SWATCH_SIZE,fill:preset.paint})];
    const png = await renderToPng(commands,{zoom:1,panX:0,panY:0,dpr:1},
      {width:SWATCH_SIZE,height:SWATCH_SIZE,background:"#ffffff"});
    const destination = new URL(`${preset.id}.png`,OUTPUT);
    await writeFile(destination,png);
    console.log(`${preset.label}: ${fileURLToPath(destination)} (${png.length} bytes)`);
  }
}
await main();
