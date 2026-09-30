/** Real native Multipoint workflow; no injected app modules, including static builds.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_pipeline_probe.js
 * Optional POWER_RP_TEST_URL points at a production /SvelteLib/ URL.
 * Owns an isolated Vite cache/browser; all evidence stays in .scratchpad/multipoint/pipeline.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { unzipSync, strFromU8 } from "fflate";
import { launchBrowser } from "./puppeteerLaunch.js";
import { freePort } from "./free_port.js";
import { imageDistance, readPng } from "./imageDistinctness.js";
import { foldState } from "../core/document.js";
import { MULTIPOINT_PRESETS } from "../core/multipoint_presets.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const artifacts = resolve(repo, ".scratchpad/multipoint/pipeline");
const BOOT_TIMEOUT = 60_000;
const SOLVE_TIMEOUT = 60_000;
const STABLE_FRAMES = 3;
const CHANGED_MEAN = 1; // a whole 8-bit code value averaged over the artwork, not UI chrome
const SAME_MEAN = 0.05; // allows subpixel edge noise after viewport restoration, not a changed field
const SVG_NAME = "multipoint-marker.svg";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><path fill="#ff0000" d="M0 0H120V60H0Z"/></svg>';
const report = { url: null, checks: [], images: {}, errors: [], expectedWarnings: [], worker: [] };
let server, browser, page, id, solidPicture, stage = "boot";
await mkdir(artifacts, { recursive: true });
process.env.POWERRP_VITE_CACHE_DIR = resolve(artifacts, `vite-cache-${process.pid}`);

/** Command. Records a completed assertion group in stdout and evidence.
 * @param {string} name - Verified behavior. @returns {void}
 * @example pass("gallery pixels differ") // prints and records that check
 */
function pass(name) { report.checks.push(name); console.log(`PASS ${name}`); }

/** Query. Returns JSON-safe raw paint or document, avoiding Svelte proxy serialization.
 * @param {boolean} whole - Read entire document instead of paint. @returns {Promise<object>}
 * @example await raw() // {type:'multipointGradient', multipoint:{features:[...]}}
 */
async function raw(whole = false) {
  return JSON.parse(await page.evaluate((id, whole) => JSON.stringify(whole ? window.__powerrp_app.doc : window.__powerrp_app.rawState().items[id].fill), id, whole));
}

/** Command. Waits for mounted editor under a bounded cold-boot timeout.
 * @returns {Promise<void>}
 * @example await ready() // editor and viewport actions exist
 */
async function ready() {
  await page.waitForFunction(() => window.__powerrp_app?.canvasActions && document.querySelector("svg.overlay") && !document.querySelector('#boot-splash'), { timeout: BOOT_TIMEOUT });
}

/** Command. Waits for real async worker completion AND stable artwork screenshots.
 * No CSS replacements, fake fills, fixed long sleeps or Inspector screenshots.
 * @param {string} name - Evidence filename stem. @returns {Promise<object>} Decoded (H,W,4) PNG, e.g. (360,640,4).
 * @example await shot("neon") // actual painted rectangle pixels
 */
async function shot(name) {
  await page.mouse.move(5, 5);
  await page.evaluate(() => { const a = window.__powerrp_app; a.selection = null; a.handleSelection = []; });
  const deadline = Date.now() + SOLVE_TIMEOUT;
  let previous, stable = 0, bytes;
  while (Date.now() < deadline) {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const pending = await page.evaluate(() => window.__mpProbe.pending);
    const clip = await page.evaluate(id => {
      const a = window.__powerrp_app, n = a.nodes().find(n => n.itemId === id);
      if (n.world.rotation !== 0) throw new Error('Artwork crop requires unrotated fixture');
      const p = a.canvasActions.worldToScreen(n.world.x, n.world.y);
      const q = a.canvasActions.worldToScreen(n.world.x + n.state.w*n.world.scale, n.world.y + n.state.h*n.world.scale);
      const r = document.querySelector("svg.overlay").getBoundingClientRect();
      return {x:Math.ceil(r.x+p.x+2),y:Math.ceil(r.y+p.y+2),width:Math.floor(q.x-p.x-4),height:Math.floor(q.y-p.y-4)};
    }, id);
    bytes = await page.screenshot({ clip });
    const png = readPng(bytes);
    if(report.errors.length) {
      await writeFile(resolve(artifacts,`${name}-failed.png`),bytes);
      if(solidPicture) report.failedPaintDistance=imageDistance(solidPicture,png);
      assert.deepEqual(report.errors, [], `browser errors during ${stage}`);
    }
    stable = !pending && previous && imageDistance(previous, png).meanAbs < SAME_MEAN ? stable + 1 : 0;
    previous = png;
    if (stable >= STABLE_FRAMES) {
      await writeFile(resolve(artifacts, `${name}.png`), bytes);
      // Interior grid measures spatial color variation, not selection outlines or
      // dithering. Quantize to 16-code bins so near-flat noise cannot pass.
      const samples=[];
      for(const fy of [0.1,0.3,0.5,0.7,0.9]) for(const fx of [0.1,0.3,0.5,0.7,0.9]) {
        const offset=4*(Math.floor(png.height*fy)*png.width+Math.floor(png.width*fx));
        samples.push([...png.data.subarray(offset,offset+3)].map(v=>Math.floor(v/16)).join(','));
      }
      report.images[name] = {width:png.width,height:png.height,distinctInteriorSamples:new Set(samples).size};
      return png;
    }
  }
  throw new Error(`Multipoint pixels/worker did not settle within ${SOLVE_TIMEOUT}ms: ${name}`);
}

/** Command. Selects artwork and clicks a real Inspector control.
 * @param {string} selector - CSS selector. @returns {Promise<void>}
 * @example await click('[aria-label="Fill: multipointGradient"]') // chooses native paint
 */
async function click(selector) {
  await page.evaluate(id => { window.__powerrp_app.selection = id; }, id);
  await page.waitForSelector(selector, {visible:true});
  await page.click(selector);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

/** Command. Checks an action is exactly one whole-document undo and redo unit.
 * @param {Function} action - Real UI gesture. @returns {Promise<void>}
 * @example await oneUndo(() => click(selector)) // commit, undo restores before, redo restores after
 */
async function oneUndo(action) {
  const before = await raw(true);
  await action();
  const after = await raw(true);
  assert.notDeepEqual(after, before, "gesture must commit an edit");
  await page.evaluate(() => window.__powerrp_app.undo());
  assert.deepEqual(await raw(true), before, "one undo restores entire document");
  await page.evaluate(() => window.__powerrp_app.redo());
  assert.deepEqual(await raw(true), after, "one redo restores entire document");
}

/** Command. Drags a real SVG modifier hit target via Puppeteer pointer events.
 * @param {string} handleId - App modifier id. @param {number} dx - Screen movement. @param {number} dy - Screen movement.
 * @returns {Promise<void>}
 * @example await drag('fill-mp-0-node-0', 25, 15) // anchor moves through CanvasView handlers
 */
async function drag(handleId, dx, dy) {
  await page.evaluate(id => { const a = window.__powerrp_app; a.selection = id; a.handleSelection = []; }, id);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const p = await page.evaluate(handleId => {
    const a = window.__powerrp_app, h = a.handles().find(h => h.id === handleId);
    if (!h) throw new Error(`Missing handle ${handleId}; available: ${a.handles().map(h=>h.id)}`);
    const s = a.canvasActions.worldToScreen(h.x,h.y), r = document.querySelector("svg.overlay").getBoundingClientRect();
    const x=r.x+s.x,y=r.y+s.y;
    if (!document.elementFromPoint(x,y)?.closest('.modifier-glyph')) throw new Error(`No real DOM modifier hit target for ${handleId} at ${x},${y}`);
    return {x,y};
  }, handleId);
  await page.mouse.move(p.x,p.y);
  await page.mouse.down();
  await page.mouse.move(p.x+dx,p.y+dy,{steps:8});
  await page.mouse.up();
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

/** Command. Renders through shipped browser debug hook and saves real Skia pixels.
 * @param {object} doc - Serialized app document. @param {string} name - PNG stem.
 * @param {number} slide - Slide index. @param {number} alpha - Tween progress.
 * @returns {Promise<object>} Decoded (360,640,4) RGBA PNG.
 * @example await frame(doc,'midpoint',1,0.5) // midpoint frame pixels
 */
async function frame(doc,name,slide=0,alpha=1) {
  const data=await page.evaluate((doc,slide,alpha)=>window.__powerrp_render(doc,{slide,alpha,width:640,height:360}),doc,slide,alpha);
  const bytes=Buffer.from(data.split(',')[1],'base64');
  await writeFile(resolve(artifacts,`${name}.png`),bytes);
  return readPng(bytes);
}

try {
  if (!process.env.POWER_RP_TEST_URL) {
    server = await createServer({configFile:resolve(here,"../web/vite.config.js"),server:{port:await freePort(),strictPort:true,host:"127.0.0.1",open:false,hmr:false,watch:null}});
    await server.listen();
  }
  const url=new URL(process.env.POWER_RP_TEST_URL ?? `http://127.0.0.1:${server.httpServer.address().port}/`);
  if (!process.env.POWER_RP_TEST_URL) url.searchParams.set('static','1'); // never touch the development backend; real static hosts must autodetect
  report.url=url.href;
  console.log(`Multipoint pipeline: ${report.url}`);
  browser = await launchBrowser({timeout:BOOT_TIMEOUT,protocolTimeout:BOOT_TIMEOUT});
  page = await browser.newPage();
  page.setDefaultTimeout(BOOT_TIMEOUT);
  await page.setViewport({width:1600,height:1000});
  page.on("pageerror", e => { report.errors.push(e.stack ?? e.message); console.error(e.stack ?? e.message); });
  page.on("console", m => {
    if (!["error","warn"].includes(m.type())) return;
    const text = m.text();
    console.error(`BROWSER ${m.type()}: ${text}`);
    // Expected local-mode discovery and headless driver messages only; solver/worker warnings fail.
    const expected = [
      /^PowerRP storage: LOCAL \(\?static=1 — forced browser-local storage\)$/,
      /^PowerRP storage: LOCAL \(no project server answered \/api\/projects\/ — running on browser-local storage\)$/,
      /^No available adapters\.$/,
      /^VideoV7: WebGPU init failed — using 2D drawImage fallback: Error: VideoV7: no WebGPU adapter$/,
      /^PowerRP videoV8: WebGPU backend unavailable, falling back to WebGL2 — videoV8 WebGPU: requestAdapter\(\) resolved no adapter$/,
      /^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/,
    ];
    const missingBackend = m.location().url === new URL('/api/projects/',url).href
      && /^Failed to load resource: the server responded with a status of 404 /.test(text);
    if (missingBackend || expected.some(pattern => pattern.test(text))) report.expectedWarnings.push(text);
    else report.errors.push(text);
  });
  await page.evaluateOnNewDocument(() => {
    window.__mpProbe = {pending:0,results:[]};
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({data}) => {
          if (!data?.key || !("result" in data || "error" in data)) return;
          window.__mpProbe.pending--;
          window.__mpProbe.results.push({key:data.key,size:data.result?.size,converged:data.result?.converged,error:data.error});
        });
      }
      postMessage(data,...args) {
        if (data?.key && data.features) window.__mpProbe.pending++;
        return super.postMessage(data,...args);
      }
    };
  });
  await page.goto(report.url,{waitUntil:"networkidle0",timeout:BOOT_TIMEOUT});
  await ready();
  id = await page.evaluate(() => {
    const a=window.__powerrp_app;
    a.clearDoc();
    a.addItem({...a.registry.get("rect").defaults,type:"rect",x:150,y:100,w:800,h:450,fill:{type:"solid",solid:"#182030"},strokeWidth:0});
    return a.selection;
  });
  const solid = solidPicture = await shot("00-solid-control");
  stage = "choose native Multipoint";
  await oneUndo(() => click('[aria-label="Fill: multipointGradient"]'));
  assert.equal((await raw()).type,"multipointGradient");
  const initial = await shot("01-native-multipoint");
  const initialDistance = imageDistance(solid,initial);
  assert.ok(initialDistance.meanAbs > CHANGED_MEAN,JSON.stringify(initialDistance));
  assert.ok(report.images['01-native-multipoint'].distinctInteriorSamples>=8,'actual Multipoint interior is spatially varied, not a flat fill');
  pass("native type UI paints spatially varied canvas pixels");

  const pictures = [];
  // The library stays open across picks (cycling), so it is opened ONCE.
  await click('.multipoint-presets .gradient-presets-toggle');
  assert.equal(await page.$$eval('.multipoint-presets .gradient-swatch',els=>els.length),MULTIPOINT_PRESETS.length,"real catalog: every preset has a swatch");
  for (const label of ["Neon spiral","Warm bokeh"]) {
    stage = `gallery ${label}`;
    await oneUndo(() => click(`.multipoint-presets [aria-label="${label}"]`));
    const name=label.toLowerCase().replaceAll(' ','-');
    pictures.push(await shot(name));
    assert.ok(report.images[name].distinctInteriorSamples>=8,`${name} must paint spatially varied pixels`);
  }
  report.presetDistance = imageDistance(...pictures);
  assert.ok(report.presetDistance.meanAbs > CHANGED_MEAN && report.presetDistance.fraction > 0.25,JSON.stringify(report.presetDistance));
  pass("real Neon spiral / Warm bokeh gallery produces materially distinct canvas pictures");

  stage = "add native geometry";
  const baseCount=(await raw()).multipoint.features.length;
  for (const kind of ["point","line","curve"]) await oneUndo(()=>click(`[aria-label="Fill: add ${kind} source"]`));
  const added=(await raw()).multipoint.features;
  assert.equal(added.length,baseCount+3);
  assert.deepEqual(added.slice(baseCount).map(f=>f.nodes.length),[1,2,2]);
  assert.ok(added[baseCount+2].nodes.some(n=>n.slice(2).some(Boolean)),"curve contains relative tangents");
  pass("point, line and curve added via real UI as individual undo units");

  stage = "real geometry drag";
  const beforeDrag=await raw();
  await oneUndo(()=>drag(`fill-mp-${baseCount}-node-0`,35,25));
  const afterDrag=await raw(), expected=structuredClone(beforeDrag);
  expected.multipoint.features[baseCount].nodes[0].splice(0,2,...afterDrag.multipoint.features[baseCount].nodes[0].slice(0,2));
  assert.notDeepEqual(afterDrag.multipoint.features[baseCount].nodes[0].slice(0,2),beforeDrag.multipoint.features[baseCount].nodes[0].slice(0,2));
  assert.deepEqual(afterDrag,expected,"anchor drag changes only selected x/y, preserving relative tangents/colors");
  stage = "real Bézier tangent drag";
  const beforeTangent=await raw();
  await oneUndo(()=>drag(`fill-mp-${baseCount+2}-node-0-outgoing`,25,-25));
  const afterTangent=await raw(), expectedTangent=structuredClone(beforeTangent);
  expectedTangent.multipoint.features[baseCount+2].nodes[0].splice(4,2,...afterTangent.multipoint.features[baseCount+2].nodes[0].slice(4,6));
  assert.deepEqual(afterTangent,expectedTangent,"tangent gesture changes only outgoing relative offsets");
  await page.waitForFunction(() => window.__mpProbe.results.some(r=>r.size===512&&r.converged),{timeout:SOLVE_TIMEOUT});
  pass("actual anchor and Bézier DOM gestures preserve unrelated paint fields; each one undo; 512 worker refinement completes");

  stage="dependent equation survives multi-frame geometry drag";
  const dependentOffset=`= self.fill.multipoint.features[${baseCount}].nodes[0][0] / 2`;
  await page.evaluate((id,index,expression)=>{
    const a=window.__powerrp_app;
    a.setPreview([[["items",id,"fill","multipoint","features",index,"stops",0,"offset"],expression]]);
    a.commitPreview();
  },id,baseCount+1,dependentOffset);
  await oneUndo(()=>drag(`fill-mp-${baseCount}-node-0`,35,0));
  assert.equal((await raw()).multipoint.features[baseCount+1].stops[0].offset,dependentOffset,
    'live re-evaluation must not bake an untouched dependent stop equation into a numeric value');
  pass('multi-frame pointer gesture preserves a dependent stop equation verbatim and undoes once');

  stage="right-side handle picker";
  await oneUndo(()=>click(`[aria-label="Fill source ${baseCount+3} Two sides"]`));
  const rightId=`fill-mp-${baseCount+2}-stop-0-right`;
  await drag(rightId,0,0); // a real DOM press selects the right-side bead
  assert.equal(await page.evaluate(()=>window.__powerrp_app.handleSelection[0]),rightId);
  await page.waitForSelector('.handle-color-field .colorfield-swatch',{visible:true});
  await page.click('.handle-color-field .colorfield-swatch');
  const beforeColor=await raw();
  await oneUndo(async()=>{
    const selector='.handle-color-field .cp-square';
    await page.waitForSelector(selector,{visible:true});
    const square=await page.$(selector),box=await square.boundingBox();
    await page.mouse.move(box.x+box.width*0.6,box.y+box.height*0.4);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*0.8,box.y+box.height*0.2,{steps:6});
    await page.mouse.up();
  });
  const afterColor=await raw(),expectedColor=structuredClone(beforeColor);
  const pickedColor=afterColor.multipoint.features[baseCount+2].stops[0].rightColor;
  assert.notEqual(pickedColor,beforeColor.multipoint.features[baseCount+2].stops[0].rightColor);
  expectedColor.multipoint.features[baseCount+2].stops[0].rightColor=pickedColor;
  assert.deepEqual(afterColor,expectedColor,'right-side picker changes only independent rightColor');
  await shot('right-color-and-tangent');
  pass('right-side on-canvas color bead opens real picker; edits only rightColor in one undo');

  stage="mode roundtrip";
  const beforeMode=await raw();
  await click('[aria-label="Fill: solid"]');
  await click('[aria-label="Fill: multipointGradient"]');
  assert.deepEqual(await raw(),beforeMode);
  pass("leave/reenter Multipoint retains native source data");

  stage="SVG persistence fixture";
  await page.evaluate(svg=>{
    const dt=new DataTransfer();dt.items.add(new File([svg],"multipoint-marker.svg",{type:"image/svg+xml"}));
    const canvas=document.querySelector("svg.overlay"),r=canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.x+80,clientY:r.y+80}));
  },SVG);
  await page.waitForFunction(()=>window.__powerrp_app.nodes().some(n=>n.state.type==="svg"));
  await page.evaluate(()=>{
    const a=window.__powerrp_app,svg=a.nodes().find(n=>n.state.type==="svg");
    a.setPreview([[["items",svg.itemId,"x"],1020],[["items",svg.itemId,"y"],180]]);a.commitPreview();
  });
  const persistedPaint=await raw();
  // Later stroke/text fixtures have different self bindings. Copy their visual
  // value, not an expression deliberately referring to this rectangle's fill.
  const resolvedPaint=JSON.parse(await page.evaluate(id=>JSON.stringify(window.__powerrp_app.nodes().find(n=>n.itemId===id).state.fill),id));
  const persistedPicture=await shot("before-save");
  await page.evaluate(()=>window.__powerrp_app.showSaveModal());
  await page.waitForSelector(".name-modal input");
  await page.$eval(".name-modal input",el=>{el.value="Multipoint pipeline";el.dispatchEvent(new Event("input",{bubbles:true}));});
  await page.$eval(".name-modal",el=>el.requestSubmit());
  await page.waitForFunction(()=>window.__powerrp_app.projectName()==="Multipoint pipeline"&&!window.__powerrp_app.saving);
  stage="same-origin browser-local reload";
  report.worker.push(...await page.evaluate(()=>window.__mpProbe.results));
  await page.reload({waitUntil:"networkidle0",timeout:BOOT_TIMEOUT});await ready();
  assert.deepEqual(await raw(),persistedPaint);
  report.reloadDistance=imageDistance(persistedPicture,await shot("after-reload"));
  assert.ok(report.reloadDistance.meanAbs<SAME_MEAN,JSON.stringify(report.reloadDistance));
  pass("browser-local Save As + same-origin reload preserves raw features and same canvas picture");

  stage="portable ZIP roundtrip";
  const archive=await page.evaluate(async()=>{
    const a=window.__powerrp_app,s=window.__powerrp_storage;
    const {bytes,warnings}=await s.buildProjectZip(a.projectName(),a.doc,s.assetStore());
    if(warnings.length)throw new Error(warnings.join("\n"));
    return Array.from(bytes);
  });
  const zip=new Uint8Array(archive),members=unzipSync(zip);
  await writeFile(resolve(artifacts,"multipoint-pipeline.zip"),zip);
  const svgKey=Object.keys(members).find(k=>k.endsWith(`/assets/${SVG_NAME}`));
  assert.ok(svgKey,`named SVG missing: ${Object.keys(members)}`);assert.equal(strFromU8(members[svgKey]),SVG);
  const zipDoc=JSON.parse(strFromU8(members[Object.keys(members).find(k=>k.endsWith("/doc.json"))]));
  assert.deepEqual(foldState(zipDoc,0,1).items[id].fill,persistedPaint);
  await page.evaluate(async bytes=>{await window.__powerrp_app.openDraftFromZipBytes(new Uint8Array(bytes),"Reopened Multipoint");},archive);
  assert.deepEqual(await raw(),persistedPaint);
  const asset=await page.evaluate(async name=>{
    const a=window.__powerrp_app,s=window.__powerrp_storage;
    const asset=(await a.listProjectAssets()).find(v=>v.name===name);
    if(!asset)throw new Error(`Reopened asset missing: ${name}`);
    return {name:asset.name,kind:asset.kind,text:await(await fetch(s.assetStore().resolveUrl(asset.url))).text()};
  },SVG_NAME);
  assert.deepEqual(asset,{name:SVG_NAME,kind:"svg",text:SVG});
  report.zipDistance=imageDistance(persistedPicture,await shot("after-zip-reopen"));
  assert.ok(report.zipDistance.meanAbs<SAME_MEAN,JSON.stringify(report.zipDistance));
  pass("portable ZIP bridge preserves named SVG bytes, native paint, and rendered picture");
  stage="integer-coordinate continuous tween";
  // Separate asset-free fixture: offscreen hook has no project-asset context.
  // Set up keyframes through app controls; never inject browser module imports.
  id=await page.evaluate(()=>{
    const a=window.__powerrp_app;a.clearDoc();
    a.addItem({...a.registry.get('rect').defaults,type:'rect',x:150,y:100,w:800,h:450,strokeWidth:0});
    return a.selection;
  });
  await page.evaluate(id=>{
    const a=window.__powerrp_app;
    const point=(x,color)=>({nodes:[[x,0.5,0,0,0,0]],stops:[{offset:0,color,rightColor:color}],weight:1,twoSided:false,closed:false});
    a.setPreview([[["items",id,"fill"],{type:"multipointGradient",multipoint:{features:[point(0,'#ff2400'),point(0.8,'#0066ff')]}}]]);a.commitPreview();
    a.addSlide();
    a.setPreview([[["items",id,"fill","multipoint","features",0,"nodes",0,0],1]]);a.commitPreview();
  },id);
  const tweenDoc=await raw(true),tweenPictures=[];
  for(const alpha of [0,0.5,1]) {
    const features=foldState(tweenDoc,1,alpha).items[id].fill.multipoint.features;
    assert.equal(features[0].nodes[0][0],alpha,'integer endpoint x must interpolate continuously');
    assert.equal(features.length,2);
    tweenPictures.push(await frame(tweenDoc,`tween-${alpha}`,1,alpha));
  }
  report.tweenDistances=[imageDistance(tweenPictures[0],tweenPictures[1]),imageDistance(tweenPictures[1],tweenPictures[2])];
  assert.ok(report.tweenDistances.every(d=>d.meanAbs>CHANGED_MEAN),JSON.stringify(report.tweenDistances));
  await page.evaluate(id=>{
    const a=window.__powerrp_app,features=JSON.parse(JSON.stringify(a.rawState().items[id].fill.multipoint.features));
    features.push({nodes:[[0.5,0.2,0,0,0,0]],stops:[{offset:0,color:'#ffff00',rightColor:'#ffff00'}],weight:1,twoSided:false,closed:false});
    a.setPreview([[["items",id,"fill","multipoint","features"],features]]);a.commitPreview();
  },id);
  const structuralDoc=await raw(true);
  assert.equal(foldState(structuralDoc,1,0.5).items[id].fill.multipoint.features.length,3,'structural count switches discretely, no phantom interpolated source');
  await frame(structuralDoc,'structural-mid-tween',1,0.5);
  pass('integer source coordinates interpolate continuously in three real renders; topology change is discrete mid-tween');
  stage='rotated non-square stroke and text paint';
  const fixtures=await page.evaluate(paint=>{
    const a=window.__powerrp_app;a.clearDoc();
    a.addItem({...a.registry.get('rect').defaults,type:'rect',x:180,y:120,w:760,h:260,fill:'#202030',stroke:paint,strokeWidth:24});
    const rect=a.selection;
    a.addItem({...a.registry.get('text').defaults,type:'text',x:180,y:470,w:850,h:150,size:110,color:paint,text:{runs:[{text:'Multipoint',outlineColor:paint,outlineWidth:3}],paras:[{}]}});
    return {rect,text:a.selection};
  },resolvedPaint);
  const poseBefore=await frame(await raw(true),'stroke-text-unrotated');
  await page.evaluate(rect=>{const a=window.__powerrp_app;a.setPreview([[["items",rect,"rotation"],Math.PI/6]]);a.commitPreview();},fixtures.rect);
  const rotatedDoc=await raw(true),poseAfter=await frame(rotatedDoc,'stroke-text-rotated');
  assert.deepEqual(foldState(rotatedDoc,0,1).items[fixtures.rect].stroke,resolvedPaint,'rotation preserves local source geometry');
  report.rotationDistance=imageDistance(poseBefore,poseAfter);
  assert.ok(report.rotationDistance.meanAbs>CHANGED_MEAN,JSON.stringify(report.rotationDistance));
  await page.evaluate(rect=>{const a=window.__powerrp_app;a.setPreview([[["items",rect,"stroke"],'#808080']]);a.commitPreview();},fixtures.rect);
  const flatStroke=await frame(await raw(true),'flat-stroke-control');
  report.strokeDistance=imageDistance(poseAfter,flatStroke);
  assert.ok(report.strokeDistance.meanAbs>CHANGED_MEAN,JSON.stringify(report.strokeDistance));
  await page.evaluate(text=>{const a=window.__powerrp_app;a.setPreview([[["items",text,"color"],'#808080'],[["items",text,"text","runs"],[{text:'Multipoint',outlineColor:'#808080',outlineWidth:3}]]]);a.commitPreview();},fixtures.text);
  report.textDistance=imageDistance(flatStroke,await frame(await raw(true),'flat-text-control'));
  assert.ok(report.textDistance.meanAbs>CHANGED_MEAN,JSON.stringify(report.textDistance));
  pass('rotated non-square stroke and text fill/outline render native fields; each differs from solid control');
  stage='narrow inspector layout';
  await page.setViewport({width:1050,height:800});
  await page.evaluate(id=>{window.__powerrp_app.selection=id;},fixtures.rect);
  await page.waitForSelector('.inspector .compound-value > .numfield');
  report.narrowFields=await page.evaluate(()=>{
    const min=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--a-vec2-box-w'));
    return [...document.querySelectorAll('.inspector .compound-value')].map(group=>({
      min,width:group.getBoundingClientRect().width,
      fields:[...group.querySelectorAll(':scope > .numfield')].map(field=>field.getBoundingClientRect().width),
    })).filter(group=>group.fields.length>=2&&group.width>0);
  });
  assert.ok(report.narrowFields.length>0,'real collapsed coordinate/size rows mounted');
  for(const group of report.narrowFields)for(const width of group.fields)
    assert.ok(width+0.5>=Math.min(group.min,group.width),`numeric field collapsed instead of wrapping: ${JSON.stringify(group)}`);
  await page.screenshot({path:resolve(artifacts,'narrow-inspector.png')});
  pass('narrow inspector wraps compound number fields before values overlap');
  assert.deepEqual(report.errors,[]);
  report.status="PASS";
} catch(error) {
  report.status="FAIL";report.stage=stage;report.stack=error.stack;
  console.error(error.stack);
  if(page&&!page.isClosed()) {
    await page.screenshot({path:resolve(artifacts,"failure.png"),fullPage:true});
    await writeFile(resolve(artifacts,"failure-state.json"),JSON.stringify(await raw(true),null,2));
  }
  process.exitCode=1;
} finally {
  try {
    if(page&&!page.isClosed()) report.worker.push(...await page.evaluate(()=>window.__mpProbe?.results??[]));
    await writeFile(resolve(artifacts,"report.json"),JSON.stringify(report,null,2));
  } finally {
    try { await browser?.close(); } finally { await server?.close(); }
    console.log(`Evidence: ${artifacts}/report.json; browser/server closed.`);
  }
}
