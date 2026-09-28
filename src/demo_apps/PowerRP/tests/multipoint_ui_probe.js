/** Native Multipoint inspector probe. Uses production PaintField + PowerRPApp,
 * without mounting CanvasView: renderer integration is a separate gate.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_ui_probe.js
 * Artifacts/cache live in repo-root .scratchpad/multipoint/ui. */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { compile } from "svelte/compiler";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../web");
const repo = resolve(here, "../../../..");
const artifacts = resolve(repo, ".scratchpad/multipoint/ui");
await mkdir(artifacts, { recursive: true });
process.env.POWERRP_VITE_CACHE_DIR ??= resolve(artifacts, "vite-cache");
for (const name of ["PaintField", "MultipointField", "ListField"]) {
  const filename = resolve(web, `${name}.svelte`);
  const result = compile(await readFile(filename, "utf8"), { filename, generate: "client" });
  for (const warning of result.warnings) console.warn(`${name}: ${warning.code}: ${warning.message}`);
  console.log(`COMPILED ${name}`);
}
await writeFile(resolve(artifacts, "index.html"), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main class="inspector"><div id="probe"></div></main><script type="module" src="./main.js"></script></body></html>');
await writeFile(resolve(artifacts, "main.js"), `
import ${JSON.stringify(`/@fs${web}/app.css`)};
import "iconify-icon";
import { mount, unmount } from "svelte";
import PaintField from ${JSON.stringify(`/@fs${web}/PaintField.svelte`)};
import { PowerRPApp } from ${JSON.stringify(`/@fs${web}/app.svelte.js`)};
const app = new PowerRPApp();
app.addItem(app.registry.get("rect").defaults);
const path = ["items", app.selection, "fill"];
app.setPreview([[path, {type:"solid",solid:"#225588",ditherMode:"off",bitDepth:5,rememberMe:{future:true}}]]);
app.commitPreview();
window.probe = { app, path, mount, unmount, PaintField };
window.probe.component = mount(PaintField, {target: document.querySelector("#probe"), props:{app,path,label:"Fill"}});
`);
const server = await createServer({ configFile: resolve(web, "vite.config.js"), server: { port: 0, host: "127.0.0.1", open: false, hmr: false, watch: null } });
await server.listen();
console.log(`Inspector-only probe: 127.0.0.1:${server.httpServer.address().port}`);
const browser = await launchBrowser();
const failures = [];
const page = await browser.newPage();
page.on("pageerror", (error) => { failures.push(error.message); console.error(error); });
page.on("console", (message) => { if (message.type() === "error") { failures.push(message.text()); console.error(message.text()); } });

/** Command. Clicks a rendered control and waits for Svelte's DOM update.
 * @param {string} selector - CSS selector. @returns {Promise<void>} */
async function click(selector) {
  await page.click(selector);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}
/** Query. Serializes raw paint from the real app store. @returns {Promise<object>} */
async function paint() {
  return JSON.parse(await page.evaluate(() => {
    const {app,path} = window.probe;
    return JSON.stringify(app.rawState().items[path[1]].fill);
  }));
}
/** Command. Proves one action changes state and is exactly one undo/redo unit.
 * @param {string} selector - Control to click. @returns {Promise<void>} */
async function oneUndo(selector) {
  const before = await page.evaluate(() => JSON.stringify(window.probe.app.doc));
  await click(selector);
  const after = await page.evaluate(() => JSON.stringify(window.probe.app.doc));
  assert.notEqual(after, before, selector);
  await page.evaluate(() => window.probe.app.undo());
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.app.doc)), before, `undo ${selector}`);
  await page.evaluate(() => window.probe.app.redo());
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.app.doc)), after, `redo ${selector}`);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

try {
  await page.setViewport({ width: 600, height: 1100 });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs${artifacts}/index.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[aria-label="Fill: multipointGradient"]');
  await oneUndo('[aria-label="Fill: multipointGradient"]');
  let stored = await paint();
  assert.equal(stored.type, "multipointGradient");
  assert.equal(stored.bitDepth, 5);
  assert.equal(stored.ditherMode, "off");
  assert.deepEqual(stored.rememberMe, { future: true });
  assert.equal(stored.multipoint.features.length, 3);
  assert.equal(await page.$$('.multipoint-source .list-field').then((x) => x.length), 9, "points expose x/y and first colour only");
  assert.equal(await page.$$('button[aria-label^="Reverse Fill source"]').then((x) => x.length), 0, "point hides reverse");
  await oneUndo('[aria-label="Fill: add line source"]');
  await oneUndo('[aria-label="Fill: add curve source"]');
  await oneUndo('[aria-label="Fill: add point source"]');
  assert.equal((await paint()).multipoint.features.length, 6);
  await oneUndo('[aria-label="Fill source 5 node: insert at position 2"]');
  const curve = (await paint()).multipoint.features[4];
  assert.equal(curve.nodes.length, 3);
  assert.ok(Math.abs(curve.nodes[0][4] - 0.1) < 1e-12, "de Casteljau updated outgoing neighbour handle");
  assert.ok(Math.abs(curve.nodes[2][2] + 0.1) < 1e-12, "de Casteljau updated incoming neighbour handle");
  assert.equal(curve.stops.length, 1, "node insertion leaves colours independent");
  await oneUndo('[aria-label="Fill source 5 colour: insert at position 2"]');
  assert.equal((await paint()).multipoint.features[4].nodes.length, 3);
  assert.equal((await paint()).multipoint.features[4].stops.length, 2);
  assert.equal(await page.$$('.multipoint-source [aria-label*="rightColor: pick"]').then((x) => x.length), 0, "one-sided paths hide right colour");
  await oneUndo('[aria-label="Fill source 5 Two sides"]');
  assert.equal(await page.$$('.multipoint-source [aria-label*="rightColor: pick"]').then((x) => x.length), 2, "two-sided paths expose independent right colours");
  await oneUndo('[aria-label="Fill source 5 Closed"]');
  await oneUndo('[aria-label="Reverse Fill source 5"]');
  const beforeHide = (await paint()).multipoint.features;
  await oneUndo('[aria-label="Source 2 Visible"]');
  assert.deepEqual((await paint()).multipoint.features, beforeHide, "source hide changes companion only");
  await oneUndo('[aria-label="Purge Source entry 6"]');
  assert.equal((await paint()).multipoint.features.length, 5);
  const beforeModeRoundtrip = await paint();
  for (const mode of ['solid','linearGradient','radialGradient','none']) await oneUndo(`[aria-label="Fill: ${mode}"]`);
  await oneUndo('[aria-label="Fill: multipointGradient"]');
  assert.deepEqual(await paint(), beforeModeRoundtrip, "all mode substates/root keys retained");
  const bodies = await page.$$('.multipoint-source');
  assert.equal(bodies.length, 5);
  await click('[aria-label="Source 5"]');
  assert.equal(await page.$$('.multipoint-source').then((x) => x.length), 4);
  await click('[aria-label="Source 5"]');
  const geometryBefore = await page.evaluate(() => [...document.querySelectorAll('.multipoint-source')].map((el) => el.getBoundingClientRect().height));
  await page.evaluate(() => {
    const {app,path} = window.probe;
    window.probe.body = document.querySelectorAll('.multipoint-source')[4];
    const features = JSON.parse(JSON.stringify(app.state().items[path[1]].fill.multipoint.features));
    features[4].nodes[1][0] = 0.42;
    app.setPreview([[[...path,"multipoint","features"], features]]);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(() => window.probe.body === document.querySelectorAll('.multipoint-source')[4]), true, "preview retains source DOM identity");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.multipoint-source')].map((el) => el.getBoundingClientRect().height)), geometryBefore, "coordinate preview does not collapse/resize rows");
  await page.evaluate(() => window.probe.app.setPreview([]));
  await page.evaluate(() => {
    const {app,path} = window.probe;
    app.setPreview([[[...path,'multipoint','features',4,'closed'], '=true']]);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(await page.$eval('[aria-label="Reverse Fill source 5"]', (el) => el.disabled), 'reverse does not silently bake equations');
  assert.ok(await page.$eval('[aria-label="Fill source 5 node: insert at position 2"]', (el) => el.disabled), 'split does not silently bake equations');
  await page.evaluate(() => window.probe.app.setPreview([]));
  // Whole-list equations are legal document values, not arrays of editable raw
  // elements. They must display without crashing or offering destructive edits.
  await page.evaluate(() => {
    const {app,path} = window.probe;
    app.setPreview([
      [[...path,'multipoint','features',4,'nodes'], '= self.fill.multipoint.features[3].nodes'],
      [[...path,'multipoint','features',4,'stops'], '= self.fill.multipoint.features[3].stops'],
    ]);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(await page.$eval('[aria-label="Reverse Fill source 5"]', el=>el.disabled),'whole-list equations cannot be reversed destructively');
  assert.ok(await page.$eval('[aria-label="Fill source 5 node: insert at position 2"]', el=>el.disabled),'whole-list equation insertion disabled');
  assert.ok(await page.$eval('.multipoint-field', el=>el.textContent.includes('Equation-driven lists are read-only')));
  await page.evaluate(() => window.probe.app.setPreview([]));
  // A purge in the outer list must not evaluate surviving nested equations.
  await page.evaluate(() => {
    const {app,path} = window.probe;
    app.setPreview([[[...path,"multipoint","features",0,"weight"], "=1 + 1"]]);
    app.commitPreview();
  });
  await oneUndo('[aria-label="Purge Source entry 4"]');
  assert.equal((await paint()).multipoint.features[0].weight, "=1 + 1", "source purge preserves nested equations");
  for (const index of [2,3]) await click(`[aria-label="Source ${index}"]`);
  await page.mouse.move(0,0);
  await page.screenshot({ path: resolve(artifacts, "inspector.png"), fullPage: true });
  await page.setViewport({width:360,height:1100});
  await page.screenshot({ path: resolve(artifacts, "inspector-narrow.png"), fullPage: true });
  await page.setViewport({width:600,height:1100});
  await page.evaluate(async () => {
    const {app,path,component,mount,unmount,PaintField} = window.probe;
    await unmount(component);
    app.addItem(app.registry.get('rect').defaults);
    const second = ['items',app.selection,'fill'];
    const first = app.rawState().items[path[1]].fill;
    app.setPreview([[second,{type:'solid',solid:'#abcdef',linear:JSON.parse(JSON.stringify(first.linear)),radial:JSON.parse(JSON.stringify(first.radial)),bitDepth:3,rememberMe:'second'}]]);
    app.commitPreview();
    window.probe.second = second;
    window.probe.component = mount(PaintField, {target:document.querySelector('#probe'),props:{app,path,paths:[path,second],label:'Fill'}});
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.$$('.multipoint-actions').then((x) => x.length), 0, "multi-selection does not offer primary-only list edits");
  assert.ok(await page.$eval('.paint-stops-multi-note', (el) => el.textContent.includes('one item at a time')));
  await oneUndo('[aria-label="Fill: solid"]');
  await oneUndo('[aria-label="Fill: multipointGradient"]');
  assert.deepEqual(await page.evaluate(() => {
    const {app,second} = window.probe;
    const paint = app.rawState().items[second[1]].fill;
    return {type:paint.type,depth:paint.bitDepth,rememberMe:paint.rememberMe,seed:paint.multipoint.features[0].stops[0].color};
  }), {type:'multipointGradient',depth:3,rememberMe:'second',seed:'#abcdef'}, "mode switching fans out without losing each target's root settings");
  assert.deepEqual(failures, [], "no browser errors");
  console.log("PASS Multipoint inspector: compile, mode/root preservation, typed sources, insertion, independent colours, reverse, collapse, undo/redo, stable preview rows.");
  console.log("Canvas rendering/export NOT tested by this inspector-only probe.");
} finally {
  await browser.close();
  await server.close();
}
