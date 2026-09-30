/** Multipoint cache-pressure scheduler regression, using production browser code.
 * Runs real preview solves/cache eviction with a controlled worker and Skia owner;
 * pixel fidelity and actual worker transport live in multipoint_pipeline_probe.js.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_cache_probe.js */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const artifacts = resolve(root, ".scratchpad/multipoint/cache");
await mkdir(artifacts, {recursive:true});
await writeFile(resolve(artifacts,"index.html"), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Multipoint cache regression</body></html>');
process.env.POWERRP_VITE_CACHE_DIR ??= resolve(artifacts,"vite-cache");
const server = await createServer({configFile:resolve(here,"../web/vite.config.js"),server:{port:0,host:"127.0.0.1",open:false,hmr:false,watch:null}});
await server.listen();
const browser = await launchBrowser();
try {
  const page = await browser.newPage(), errors = [], warnings = [];
  page.on("pageerror", e => { errors.push(e.message); console.error(e); });
  page.on("console", m => {
    if(m.type()==="error") { errors.push(m.text()); console.error(m.text()); }
    if(m.type()==="warn") { warnings.push(m.text()); console.warn(m.text()); }
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs${artifacts}/index.html`);
  const result = await page.evaluate(async (root) => {
    const {SkiaSurface} = await import(`${root}/render_gpu/skia/browser_surface.js`);
    const {withMultipointPreview,multipointShader,disposeMultipointImages} = await import(`${root}/render_gpu/skia/multipoint.js`);
    const originalWorker = window.Worker, started = [];
    let worker, requests;
    window.Worker = class {
      /** Command. Records the fake worker; no threads or resources are allocated. */
      constructor() { worker=this; }
      /** Command. Captures the production scheduler's next job. @param {object} job Source record. */
      postMessage(job) { this.job=job; started.push(job.key); }
    };
    const CK = {ColorType:{RGBA_F16:1},AlphaType:{Premul:1},ColorSpace:{SRGB:1},TileMode:{Clamp:1},FilterMode:{Linear:1},MipmapMode:{None:0},MakeImage:()=>({delete(){},makeShaderOptions:()=>({delete(){}})})};
    // 1024² F16 fields are 8 MiB each: ten exceed the 64 MiB field budget.
    const paints = Array.from({length:10},(_,i)=>({resolution:1024,features:[{nodes:[[0.5,0.5,0,0,0,0]],stops:[{offset:0,color:[i/10,0.5,0.5,1],rightColor:[i/10,0.5,0.5,1]}],weight:1,twoSided:false,closed:false}]}));
    const surface = Object.assign(Object.create(SkiaSurface.prototype), {_multipointWorker:null,_multipointTimer:null,_multipointPending:[],_multipointActive:new Set(),_multipointCompleted:new Set(),_multipointFailed:new Set(),_multipointBusy:false,_multipointReady:false,_lastRender:[]});
    /** Command. Runs the actual field cache and scheduling paths, without a GL context. */
    surface.render = () => {
      requests=withMultipointPreview(()=>{for(const paint of paints)multipointShader(CK,paint,{x:0,y:0,w:100,h:100},1).delete();});
      surface._queueMultipoint(requests);
    };
    /** Command. Completes bounded fake worker jobs; returns false if the queue cycles.
     * @returns {boolean} True when pending work drains within twenty completions. */
    function drain() {
      for(let i=0;i<20;i++) {
        clearTimeout(surface._multipointTimer);
        surface._multipointReady=true; surface._pumpMultipoint();
        if(!surface._multipointBusy) return true;
        worker.onmessage({data:{key:worker.job.key,field:{size:worker.job.size,half:new Uint16Array(worker.job.size**2*4),domain:{x:0,y:0,w:1,h:1}}}});
      }
      return false;
    }
    try {
      surface.render();
      const drained=drain(), firstCount=started.length, distinct=new Set(started).size;
      const active=surface._multipointActive.size, completed=surface._multipointCompleted.size;
      const previewCount=requests.filter(r=>!r.ready).length;
      surface.render(); const repeatDrained=drain(), repeatCount=started.length;
      paints[0].features[0].stops[0].color[0]=0.901;
      surface.render(); const editDrained=drain(), editCount=started.length;
      surface._queueMultipoint([]);
      return {drained,firstCount,distinct,active,completed,previewCount,repeatDrained,repeatCount,editDrained,editCount,emptyActive:surface._multipointActive.size,emptyCompleted:surface._multipointCompleted.size};
    } finally { clearTimeout(surface._multipointTimer); window.Worker=originalWorker; disposeMultipointImages(CK); }
  }, `/@fs${resolve(here,"..")}`);
  assert.equal(result.drained,true,"cache pressure must not make an infinite refinement cycle");
  assert.equal(result.firstCount,10); assert.equal(result.distinct,10);
  assert.equal(result.active,10,"cache hits remain visible to the scheduler");
  assert.equal(result.completed,10);
  assert.ok(result.previewCount>0,"fixture actually exceeds the final-field cache budget");
  assert.equal(result.repeatDrained,true); assert.equal(result.repeatCount,10,"unchanged scene must not resubmit evicted fields");
  assert.equal(result.editDrained,true); assert.equal(result.editCount,11,"one changed source gets exactly one fresh solve");
  assert.equal(result.emptyActive,0); assert.equal(result.emptyCompleted,0,"departed sources do not grow bookkeeping forever");
  assert.equal(warnings.filter(w=>w.includes("Multipoint viewport cache evicted")).length,1,"quality limit is reported once");
  assert.deepEqual(errors,[]);
  console.log("PASS Multipoint: ten active fields drain once, cache-hit visibility, no requeue on eviction, one solve per edit, bounded bookkeeping",result);
} finally { await browser.close(); await server.close(); }
