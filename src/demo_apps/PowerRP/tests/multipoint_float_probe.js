/** Actual GPU float-upload/alpha/dither regression for the shared Multipoint shader.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_float_probe.js */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchBrowser } from "./puppeteerLaunch.js";
import { toHalf } from "../render_gpu/skia/shape_sdf.js";

assert.equal(toHalf(0),0); assert.equal(toHalf(1),0x3c00);
assert.equal(toHalf(0.75 * 2 ** -24),1,"round subnormal upward instead of prematurely flushing it");
assert.equal(toHalf((1024 - 0.25) * 2 ** -24),0x0400,"subnormal carry reaches smallest normal, not zero");
assert.equal(toHalf(-(1024 - 0.25) * 2 ** -24),0x8400);
const require = createRequire(import.meta.url);
const wasm = (await readFile(require.resolve("canvaskit-wasm/bin/canvaskit.wasm"))).toString("base64");
const bundle = await build({stdin:{contents:"export * from './src/demo_apps/PowerRP/render_gpu/skia/multipoint.js'; export * from './src/demo_apps/PowerRP/render_gpu/skia/gradient.js';",resolveDir:fileURLToPath(new URL("../../../../",import.meta.url))},bundle:true,write:false,format:"iife",globalName:"MP",platform:"browser"});
const drivers = process.platform === "darwin" ? ["swiftshader", "metal"] : ["swiftshader"];
for (const driver of drivers) {
const browser = await launchBrowser(driver === "metal" ? {args:["--use-gl=angle","--use-angle=metal","--no-sandbox","--ignore-gpu-blocklist"]} : {});
try {
  const page = await browser.newPage(), errors=[];
  page.on("pageerror",e=>{errors.push(e.message);console.error(e);});
  page.on("console",m=>{if(m.type()==="error"){errors.push(m.text());console.error(m.text());}});
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  await page.addScriptTag({path:require.resolve("canvaskit-wasm/bin/canvaskit.js")});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const result=await page.evaluate(async wasm=>{
    const CK=await CanvasKitInit({locateFile:()=>`data:application/wasm;base64,${wasm}`});
    const c=document.getElementById("c"),handle=CK.GetWebGLContext(c,{alpha:1,premultipliedAlpha:1,antialias:1,majorVersion:2}),gr=CK.MakeWebGLContext(handle),gl=c.getContext("webgl2");
    gl.getExtension("EXT_color_buffer_float");
    const debug=gl.getExtension("WEBGL_debug_renderer_info"),renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
    const info={width:64,height:64,colorType:CK.ColorType.RGBA_F16,alphaType:CK.AlphaType.Premul,colorSpace:CK.ColorSpace.SRGB};
    const surface=CK.MakeRenderTarget(gr,info);
    if(!surface)throw new Error("GPU cannot create an F16 verification target; precision was not verified.");
    /** Pure function. Builds a constant native point field. @param {number[]} color Straight RGBA. @returns {object} Paint.
     * @example field([0.4,0.4,0.4,1]).features.length // 1 */
    function field(color){return {type:"multipointGradient",features:[{nodes:[[.5,.5,0,0,0,0]],stops:[{offset:0,color}],weight:1}]};}
    /** Command. Draws the actual production shader and reads RGBA pixels.
     * @param {object} target Skia surface. @param {object} paint Native field.
     * @param {number} opacity Layer opacity. @param {object} colorType Readback format.
     * @returns {number[]} Flattened (64,64,4) premultiplied RGBA, float or bytes. */
    function draw(target,paint,opacity,colorType){
      const canvas=target.getCanvas(),shader=MP.skShaderForPaint(CK,paint,{x:0,y:0,w:64,h:64},opacity,canvas.getTotalMatrix()),p=new CK.Paint();
      p.setShader(shader);canvas.clear(CK.TRANSPARENT);canvas.drawRect(CK.XYWHRect(0,0,64,64),p);target.flush();
      const image=target.makeImageSnapshot(),dst=CK.Malloc(colorType===CK.ColorType.RGBA_F32?Float32Array:Uint8Array,64*64*4);
      const pixels=image.readPixels(0,0,{...info,colorType},dst);
      if(!pixels)throw new Error("Multipoint GPU readback failed.");
      const copy=Array.from(pixels);CK.Free(dst);image.delete();p.delete();shader.delete();return copy;
    }
    try {
      const a=draw(surface,field([.4001,.4001,.4001,1]),1,CK.ColorType.RGBA_F32);
      const b=draw(surface,field([.4003,.4003,.4003,1]),1,CK.ColorType.RGBA_F32);
      const alpha=draw(surface,field([.8008,.2008,.4008,.25]),.4,CK.ColorType.RGBA_F32).slice(0,4);
      const screen=CK.MakeOnScreenGLSurface(gr,64,64,CK.ColorSpace.SRGB);
      if(!screen)throw new Error("GPU could not create final RGBA8 display target.");
      try {
        const paint=field([100.5/255,100.5/255,100.5/255,1]);
        const off=draw(screen,paint,1,CK.ColorType.RGBA_8888);
        const on=draw(screen,{...paint,ditherMode:"bayer",ditherEmphasis:1,ditherBayerSize:8},1,CK.ColorType.RGBA_8888);
        let changed=0;for(let i=0;i<off.length;i+=4)if(off[i]!==on[i])changed++;
        return {renderer,firstA:a[0],firstB:b[0],alpha,changed,off:[...new Set(off.filter((_,i)=>i%4===0))],on:[...new Set(on.filter((_,i)=>i%4===0))],glError:gl.getError()};
      }finally{screen.delete();}
    }finally{MP.disposeMultipointImages(CK);surface.delete();gr.delete();CK.deleteContext(handle);}
  },wasm);
  const HALF_FLOAT_TOLERANCE=0.0003;
  assert.ok(result.firstB>result.firstA,"sub-byte differences must survive GPU image sampling");
  assert.ok(Math.abs(result.firstA-.4001)<HALF_FLOAT_TOLERANCE);
  assert.ok(Math.abs(result.firstB-.4003)<HALF_FLOAT_TOLERANCE);
  for(const [i,expected] of [.08008,.02008,.04008,.1].entries())assert.ok(Math.abs(result.alpha[i]-expected)<HALF_FLOAT_TOLERANCE,`premultiplied channel ${i}: ${result.alpha[i]} vs ${expected}`);
  assert.ok(result.changed>0&&result.changed<64*64,"half-step grey must dither, not arrive pre-quantized");
  assert.equal(result.on.length,2);assert.equal(result.off.length,1);assert.equal(result.glError,0);assert.deepEqual(errors,[]);
  console.log("PASS actual GPU Multipoint fractional colour, alpha/opacity, dither and half-float subnormal boundaries",result);
}finally{await browser.close();}
}
