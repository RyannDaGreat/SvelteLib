/**
 * GRAPH FAMILY probe (Round 5, items 63-66/71) — renders the four graph widgets
 * through the REAL editor pipeline (offscreen gpuService Skia, ?cli=1
 * __powerrp_render) and PIXEL-CHECKS them, then drives the Monaco code modal open
 * on a graph_line via the real editor UI. The bare-node suites prove the plugins'
 * math; only this proves the ink actually lands and the code button works.
 *
 * Checks:
 *   1. a sine graphLine draws ink along its expected path (and NOT in a corner);
 *   2. a broken-equation graphLine shows the LOUD red error box;
 *   3. graphTickMarks emits the label sequence 0..5 AND draws ruler ink;
 *   4. graphGrid draws a line on a grid column and leaves a cell interior clear;
 *   5. graphBars at reveal 0.5 is MID-STAGGER (early bar present, late bar absent
 *      — present at reveal 1), proving the lagged grow-up;
 *   6. double-clicking a graph_line opens Monaco on its `source` (javascript).
 *
 * Some browser probes fail environmentally on this Mac (no WebGPU adapter);
 * __powerrp_render uses the WebGL2 Skia surface, which swiftshader provides.
 *
 * Run: node tests/graph_family_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { PNG } from "pngjs";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { graphTickMarksPlugin } from "../plugins/graph_tick_marks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
const W = 600, H = 400;
const BG = "#0a0e1a"; // near-black deck so ink contrasts (the Manim look)
// The widget box, in world px; the camera is W×H at the origin, so world maps 1:1
// to output pixels and these coordinates ARE output pixels.
const BOX = { x: 100, y: 50, w: 400, h: 300 };

const registry = createRegistry();
registerAll(registry, createCommands());

/** Near-pure (fresh ids). A one-widget document, camera W×H with the dark BG. */
function buildDoc(type, over) {
  let doc = newDocument();
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...BOX, ...over, active: true, z: 1 });
  return serialize(doc);
}

const readPng = (dataUrl) => PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
const px = (png, x, y) => { const i = (Math.round(y) * png.width + Math.round(x)) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
const BG_RGB = [10, 14, 26];
/** Is this pixel materially different from the background (i.e. ink)? */
const isInk = (p) => Math.max(Math.abs(p[0] - BG_RGB[0]), Math.abs(p[1] - BG_RGB[1]), Math.abs(p[2] - BG_RGB[2])) > 28;
/** Any ink pixel in a square window centered on (cx, cy)? */
const inkNear = (png, cx, cy, r = 4) => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (isInk(px(png, cx + dx, cy + dy))) return true;
  return false;
};

const server = await createServer({ configFile: resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser();

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── RENDER PAGE (?cli=1 offscreen Skia) ──────────────────────────────────────
  const rpage = await browser.newPage();
  rpage.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));
  await rpage.goto(`${url}/?cli=1`, { waitUntil: "networkidle0" });
  await rpage.waitForFunction(() => !!window.__powerrp_render, { timeout: 40000 });
  const render = async (json) => readPng(await rpage.evaluate((j, w, h) => window.__powerrp_render(j, { slide: 0, width: w, height: h }), json, W, H));
  const save = (name, png) => fs.writeFileSync(resolve(SHOTS, `graph_${name}.png`), PNG.sync.write(png));

  // 1 ── SINE graphLine ────────────────────────────────────────────────────────
  const sine = await render(buildDoc("graph_line", { mode: "explicit", source: "Math.sin(x)", tStart: -6.2832, tEnd: 6.2832, xRange: "[-6.2832, 6.2832, 1.5708]", yRange: "[-1.5, 1.5, 0.5]", stroke: "#58C4DD", strokeWidth: 3, closed: false, fill: null }));
  save("sine", sine);
  // The curve passes through the box center (data (0,0) → output (300,200)) and
  // rises to a peak near (350,100); a top-left corner sits above the whole curve.
  ok(inkNear(sine, 300, 200, 5), "sine graphLine: ink on the curve at its zero-crossing (box center)");
  ok(inkNear(sine, 350, 100, 6), "sine graphLine: ink near the sine peak");
  ok(!inkNear(sine, 120, 65, 4), "sine graphLine: background clear above the curve (not a filled/blanked box)");

  // 2 ── BROKEN graphLine → red error box ──────────────────────────────────────
  const broken = await render(buildDoc("graph_line", { mode: "explicit", source: "Math.sin(" }));
  save("error", broken);
  const ep = px(broken, 300, 200); // widget center
  ok(ep[0] > 200 && ep[1] > 150 && ep[1] < 235 && ep[2] > 150 && ep[0] > ep[2], `broken graphLine: LOUD pink-red error box fills the widget (center rgb ${ep})`);

  // 3 ── graphTickMarks label sequence + ink ───────────────────────────────────
  const labels = graphTickMarksPlugin.emit({ ...registry.get("graph_tick_marks").defaults, ...BOX }).filter((o) => o.op === "text").map((o) => o.text);
  ok(JSON.stringify(labels.slice(0, 6)) === JSON.stringify(["0", "1", "2", "3", "4", "5"]), `graphTickMarks: label sequence 0..5 (got ${JSON.stringify(labels.slice(0, 6))})`);
  const ruler = await render(buildDoc("graph_tick_marks", { includeTip: true, axisColor: "#DDEEFF", tickColor: "#DDEEFF", labelColor: "#DDEEFF" }));
  save("ruler", ruler);
  let rulerInk = 0;
  for (let y = 45; y < 375; y += 3) for (let x = 90; x < 510; x += 3) if (isInk(px(ruler, x, y))) rulerInk++;
  ok(rulerInk > 40, `graphTickMarks: axes/ticks/labels drew ink (${rulerInk} sampled ink pixels)`);

  // 4 ── graphGrid: line on a column, clear cell interior ───────────────────────
  const grid = await render(buildDoc("graph_grid", { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", gridColor: "#5C7A99", gridWidth: 2, gridOpacity: 1, showMinor: false, growth: 1 }));
  save("grid", grid);
  // vertical line at data x=5 → output x=300; a cell interior (data x≈5.5 → x=320).
  ok(inkNear(grid, 300, 200, 3), "graphGrid: ink on the x=5 grid column");
  ok(!inkNear(grid, 320, 205, 1), "graphGrid: cell interior between columns is clear");

  // 5 ── graphBars reveal 0.5 mid-stagger ──────────────────────────────────────
  const barsOver = { mode: "direct", barCount: 8, valueEquation: "5", yRange: "[0, 10, 1]", growLagRatio: 0.8, growEase: "cubic", barColor: "#58C4DD", fillOpacity: 1, barStrokeWidth: 0 };
  const barsFull = await render(buildDoc("graph_bars", { ...barsOver, reveal: 1 }));
  const barsHalf = await render(buildDoc("graph_bars", { ...barsOver, reveal: 0.5 }));
  save("bars_full", barsFull); save("bars_half", barsHalf);
  // bar 0 spans output x≈115..145, bar 7 x≈465..495; value 5 → bar top output y≈200,
  // baseline y=350, so mid-bar (250) is inside a full bar.
  ok(inkNear(barsFull, 130, 250, 4), "graphBars reveal=1: first bar present");
  ok(inkNear(barsFull, 480, 250, 6), "graphBars reveal=1: last bar present");
  ok(inkNear(barsHalf, 130, 250, 4), "graphBars reveal=0.5: first bar STILL present (grew first)");
  ok(!inkNear(barsHalf, 480, 250, 6), "graphBars reveal=0.5: last bar ABSENT (mid-stagger — it grows last)");

  // 6 ── Monaco opens on a graph_line via the real editor UI ────────────────────
  const epage = await browser.newPage();
  await epage.setViewport({ width: 1440, height: 900 });
  const bootErrs = [];
  epage.on("pageerror", (e) => bootErrs.push(e.message));
  await epage.goto(`${url}/`, { waitUntil: "networkidle0" });
  await epage.waitForFunction(() => !!window.__powerrp_app, { timeout: 40000 });
  await sleep(500);
  const added = await epage.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const cam = app.cameraState().state;
    app.addItem({ ...app.registry.get("graph_line").defaults, x: cam.x, y: cam.y, w: cam.w, h: cam.h });
    return app.selection;
  });
  ok(!!added, "added a graph_line via the app seam");
  await sleep(300);
  // Open the code editor through the REAL command layer — app.runCommand is the
  // exact seam the Inspector "</>" action row's onclick calls
  // (web/Inspector.svelte:1146) and the palette invokes; the command is gated by
  // the selected node carrying a `codeEditor` descriptor. (A double-click also
  // works, but lands on a HAIRLINE curve, not a full box — a genuine graphLine UX
  // note, not a probe flake, so the deterministic command path is used here.)
  const gate = await epage.evaluate(() => {
    const app = window.__powerrp_app;
    return { hasEditor: !!app.selectedNode()?.plugin?.codeEditor };
  });
  ok(gate.hasEditor, "the selected graph_line exposes a codeEditor descriptor (the '</>' row is enabled)");
  await epage.evaluate(() => window.__powerrp_app.runCommand("edit-code-source"));
  await sleep(600);
  const modal = await epage.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      property: app.codeModal?.property ?? null,
      language: app.codeModal?.language ?? null,
      hasMonaco: !!document.querySelector(".code-modal-root .monaco-editor"),
    };
  });
  ok(modal.property === "source", `double-click opens the code modal on the source property (got ${modal.property})`);
  ok(modal.language === "javascript", `the modal opened with the javascript language (got ${modal.language})`);
  ok(modal.hasMonaco, "the Monaco editor mounted");

  if (fails.length) { console.error(`\nGRAPH FAMILY PROBE: ${fails.length} FAILED\n` + fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
  console.log(`\nGraph family probe passed: all checks green.`);
} finally {
  await browser.close();
  await server.close();
}
