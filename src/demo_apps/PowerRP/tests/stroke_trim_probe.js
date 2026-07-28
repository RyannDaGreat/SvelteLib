/**
 * STROKE-TRIM framework probe (browser) — the gate for the universal stroke
 * trim/phase/cap options (manifest E.12-15). Renders a thick-stroked square
 * through the SAME __powerrp_render seam the CLI uses (?cli=1, world == px), so it
 * exercises the WHOLE pipeline the editor uses: the ports UNIVERSAL STROKE-TRIM
 * seam (state → op), render_gpu/ir.js normalization, and paint_skia's ContourMeasure
 * path preprocessing + caps — on the real WebGL2 Skia surface, not the node CPU one.
 *
 * FIVE machine assertions, each also a screenshot in .claude_vlm_checks/stroke_trim_*:
 *   BYTE-IDENTITY — a rect carrying an IDENTITY trim state (start 0, end 1, phase 0,
 *     flat caps) renders BYTE-FOR-BYTE identical to a plain rect with no trim
 *     fields at all (the absent-is-legacy contract, proven end-to-end).
 *   TRIM — strokeEnd 0.5 leaves roughly HALF the outline drawn: markedly fewer dark
 *     pixels than the full stroke, with at least one edge midpoint gone (cut) and at
 *     least one still present (kept).
 *   PHASE-ON-DASHES — a dashes-material stroke shifted by strokePhase 0.5 differs
 *     from phase 0: the trim preprocessing feeds the rotated path to the material,
 *     so the dash pattern starts at a new origin (pattern moved, not just redrawn).
 *   CAPS — round vs flat vs taper at the trimmed ends all render DIFFERENTLY (each
 *     pair byte-differs); taper covers fewer pixels than flat (it narrows to a point).
 *
 * Spawns its own Vite + headless Chromium (swiftshader) — the stroke_material_probe
 * pattern. Frontend-only. Run: node src/demo_apps/PowerRP/tests/stroke_trim_probe.js
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

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 300, H = 260;
const BG = "#ffffff";
// A centered square, thick black stroke — its perimeter is the outline we trim.
const BOX = { x: 70, y: 50, w: 160, h: 160 };
const STROKE_W = 12;

const registry = createRegistry();
registerAll(registry, createCommands());

/** Near-pure (fresh ids). A document with THE camera at W×H and one stroked square
 *  carrying the given trim/stroke overrides. `stroke` defaults to solid black. */
function boxDoc(over = {}, stroke = "#000000") {
  let doc = newDocument(), z = 1;
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  [doc] = withNewItem(doc, 0, {
    ...registry.get("rect").defaults,
    ...BOX, fill: null, stroke, strokeWidth: STROKE_W, cornerRadius: 0,
    active: true, z: z++, ...over,
  });
  return serialize(doc);
}

const DASHES = { type: "material", material: { id: "dashes", params: { pattern: "dash", dash: 18, gap: 12 } } };

/** Pure function. Count of near-black pixels (the stroke) in a decoded PNG. */
function darkCount(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4)
    if (png.data[i] < 90 && png.data[i + 1] < 90 && png.data[i + 2] < 90) n++;
  return n;
}
const isDark = (png, x, y) => { const i = (y * png.width + x) * 4; return png.data[i] < 90 && png.data[i + 1] < 90; };
const bytesEq = (a, b) => Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_render, { timeout: 40000 });

  const render = async (docJson, name) => {
    const dataUrl = await page.evaluate(
      (json, w, h) => window.__powerrp_render(json, { slide: 0, width: w, height: h }),
      docJson, W, H,
    );
    const png = readPng(Buffer.from(dataUrl.split(",")[1], "base64"));
    if (name) fs.writeFileSync(resolve(SHOTS, `stroke_trim_${name}.png`), PNG.sync.write(png));
    return png;
  };

  // 1) BYTE-IDENTITY — no trim vs explicit identity trim state.
  const plain = await render(boxDoc({}), "baseline");
  const identity = await render(boxDoc({ strokeStart: 0, strokeEnd: 1, strokePhase: 0, strokeCapStart: "flat", strokeCapEnd: "flat" }), "identity");
  ok(bytesEq(plain, identity), "identity trim state renders BYTE-IDENTICAL to a plain rect (absent-is-legacy, end-to-end)");

  // 2) TRIM — strokeEnd 0.5 draws ~half the perimeter.
  const half = await render(boxDoc({ strokeEnd: 0.5 }), "half");
  const full = darkCount(plain), kept = darkCount(half);
  ok(kept < full * 0.7 && kept > full * 0.3, `strokeEnd 0.5 keeps roughly half the outline (${kept} dark px vs full ${full})`);
  // Edge midpoints: at least one cut (now white), at least one kept (still dark).
  const mids = [[BOX.x + BOX.w / 2, BOX.y], [BOX.x + BOX.w, BOX.y + BOX.h / 2], [BOX.x + BOX.w / 2, BOX.y + BOX.h], [BOX.x, BOX.y + BOX.h / 2]].map(([x, y]) => [Math.round(x), Math.round(y)]);
  const keptMids = mids.filter(([x, y]) => isDark(half, x, y)).length;
  const baseMids = mids.filter(([x, y]) => isDark(plain, x, y)).length;
  ok(baseMids === 4, `full stroke marks all four edge midpoints dark (${baseMids}/4)`);
  ok(keptMids >= 1 && keptMids <= 3, `trim keeps SOME edges and cuts SOME (${keptMids}/4 midpoints still drawn)`);

  // 3) PHASE ON A DASHED PATTERN — feeding the rotated path to the material shifts
  //    where the dashes sit. Same trim window, different phase → different pixels.
  const dashP0 = await render(boxDoc({ strokePhase: 0 }, DASHES), "dash_phase0");
  const dashP5 = await render(boxDoc({ strokePhase: 0.5 }, DASHES), "dash_phase5");
  ok(darkCount(dashP0) > 0, `dashed stroke paints a pattern (${darkCount(dashP0)} dark px)`);
  ok(!bytesEq(dashP0, dashP5), "strokePhase 0.5 SHIFTS the dash pattern vs phase 0 (preprocessing feeds the material)");

  // 4) CAPS — round vs flat vs taper at the trimmed ends must all differ.
  const flat = half; // strokeEnd 0.5, default flat caps
  const round = await render(boxDoc({ strokeEnd: 0.5, strokeCapStart: "round", strokeCapEnd: "round" }), "roundcap");
  const taper = await render(boxDoc({ strokeEnd: 0.5, strokeCapStart: "taper", strokeCapEnd: "taper" }), "tapercap");
  ok(!bytesEq(flat, round), "round caps differ from flat at the trimmed ends");
  ok(!bytesEq(flat, taper), "taper caps differ from flat at the trimmed ends");
  ok(!bytesEq(round, taper), "taper caps differ from round caps");
  ok(darkCount(taper) < darkCount(flat), `taper narrows to a point — fewer dark px than flat (${darkCount(taper)} < ${darkCount(flat)})`);
  console.log("  shots in .claude_vlm_checks/stroke_trim_*.png");
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — stroke trim framework`);
  process.exit(1);
}
console.log("\nPASS — stroke trim framework (byte-identity, trim, phase-on-dashes, caps)");
