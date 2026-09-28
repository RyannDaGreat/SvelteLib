/** Focused bare-node solver checks. Heavy 512² benchmarks stay in .scratchpad. */
import assert from 'node:assert/strict';
import { solveMultipoint } from '../core/multipoint_diffusion.js';
import { featurePolyline, insertFeatureNode, reverseFeature } from '../core/multipoint.js';

const RED = [1,0,0,1], BLUE = [0,0,1,1], CLEAR = [0,1,0,0];

/**
 * Pure function. Build a parsed source fixture from anchors or full node tuples.
 * @param {number[][]} nodes [N,2] (x,y) or [N,6] nodes, e.g. [[.2,.5],[.8,.5]].
 * @param {number[]} color Straight RGBA [4].
 * @param {object} extra Overrides for two-sided colors, stops, weight or closure.
 * @returns {object} Parsed feature with [N,6] nodes and [S,4] colors.
 * @example feature([[.5,.5]],[1,0,0,1]).nodes // [[.5,.5,0,0,0,0]]
 */
function feature(nodes, color = RED, extra = {}) {
  return {nodes:nodes.map(n => n.length === 2 ? [...n,0,0,0,0] : n), stops:[{offset:0,color,rightColor:BLUE}], twoSided:false, closed:false, weight:1, ...extra};
}

/**
 * Pure function. Read nearest texel at an original logical position.
 * @param {object} result Solver output (H,W,4) premultiplied RGBA, e.g. (128,128,4).
 * @param {number} x Logical x.
 * @param {number} y Logical y.
 * @returns {number[]} RGBA [4].
 * @example pixel({size:1,domain:{x:0,y:0,w:1,h:1},pixels:[1,0,0,1]},.5,.5) // [1,0,0,1]
 */
function pixel(result, x, y) {
  const {size,domain:d} = result;
  const ix = Math.max(0,Math.min(size-1,Math.floor((x-d.x)/d.w*size))), iy = Math.max(0,Math.min(size-1,Math.floor((y-d.y)/d.h*size)));
  return Array.from(result.pixels.slice(4*(iy*size+ix),4*(iy*size+ix)+4));
}

/**
 * Command. Assert maximum absolute component error, returning measured error.
 * @param {ArrayLike<number>} actual Actual vector.
 * @param {ArrayLike<number>} expected Same-shaped expected vector.
 * @param {number} tolerance Absolute bound.
 * @returns {number} Maximum difference.
 * @example near([.25,.5],[.25,.5],1e-6) // 0
 */
function near(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length,expected.length);
  let error = 0;
  for (let i=0;i<actual.length;i++) error = Math.max(error,Math.abs(actual[i]-expected[i]));
  assert.ok(error<=tolerance,`maximum error ${error} > ${tolerance}`);
  return error;
}

/**
 * Command. Solve and assert convergence, finiteness and premultiplied bounds.
 * @param {object[]} features Parsed features.
 * @param {number} size Grid side.
 * @returns {object} Checked (size,size,4) premultiplied RGBA result.
 * @example checked([feature([[.5,.5]])],32).converged // true
 */
function checked(features, size = 128) {
  const result = solveMultipoint(features,{size,tolerance:1e-8});
  assert.ok(result.converged,`residual ${result.relativeResidual}, iterations ${result.iterations}`);
  assert.ok(result.pixels instanceof Float32Array);
  assert.equal(result.pixels.length,size*size*4);
  for (let i=0;i<result.pixels.length;i+=4) {
    const a = result.pixels[i+3];
    assert.ok(Number.isFinite(a) && a>=-1e-5 && a<=1+1e-5);
    for (let c=0;c<3;c++) assert.ok(Number.isFinite(result.pixels[i+c]) && result.pixels[i+c]>=-1e-5 && result.pixels[i+c]<=a+1e-5);
  }
  return result;
}

/**
 * Command. Print one timed assertion group; exceptions remain uncaught.
 * @param {string} name Case description.
 * @param {Function} check Assertion block.
 * @returns {undefined}
 * @example test('sum',()=>assert.equal(2+2,4)) // prints ok sum
 */
function test(name, check) { const start=performance.now(); check(); console.log(`ok ${name} (${(performance.now()-start).toFixed(1)} ms)`); }

const slit = feature([[.25,.5],[.75,.5]],RED,{twoSided:true});
const cubic = feature([[.2,.65,0,0,.2,-.5],[.8,.35,-.2,.5,0,0]],RED,{twoSided:true,stops:[
  {offset:0,color:RED,rightColor:BLUE}, {offset:.7,color:[1,.7,0,.8],rightColor:[0,1,.4,.3]}, {offset:1,color:CLEAR,rightColor:RED},
]});

test('contract, fractional float color, empty and isolated sources',()=>{
  const r=checked([feature([[.5,.5]],[.8,.2,.4,.25])]);
  assert.deepEqual(r.domain,{x:0,y:0,w:1,h:1});
  near(pixel(r,.1,.9),[.2,.05,.1,.25],1e-7);
  assert.equal(r.iterations,0);
  assert.notEqual(r.pixels[1]*255,Math.round(r.pixels[1]*255));
  assert.ok(checked([]).pixels.every(v=>v===0));
  assert.ok(checked([feature([[.2,.3]],CLEAR)]).pixels.every(v=>v===0));
  near(checked([feature([[.5,.5]],RED,{stops:[{offset:0,color:RED},{offset:0,color:BLUE}]})]).pixels,r.pixels.map((_,i)=>RED[i%4]),1e-7);
});

test('finite endpoints reconnect; no artificial seam beyond tips',()=>{
  const a=checked([slit],128), b=checked([slit],256);
  assert.ok(pixel(a,.5,.49)[0]>.97 && pixel(a,.5,.51)[2]>.97);
  const inside=Math.abs(pixel(a,.5,.5-1/256)[0]-pixel(a,.5,.5+1/256)[0]);
  const outside=Math.abs(pixel(a,.9,.5-1/256)[0]-pixel(a,.9,.5+1/256)[0]);
  const refined=Math.abs(pixel(b,.9,.5-1/512)[0]-pixel(b,.9,.5+1/512)[0]);
  assert.ok(inside>.97 && outside<.02 && refined<outside*.6);
  console.log({inside,outside,refined});
});

test('boundary split and closed last-to-first ring preserve physical sides',()=>{
  const split=checked([feature([[.5,0],[.5,1]],RED,{twoSided:true})]);
  near(pixel(split,.2,.2),BLUE); near(pixel(split,.8,.8),RED);
  const ring=feature([[.25,.25],[.75,.25],[.75,.75],[.25,.75]],RED,{closed:true,twoSided:true});
  const r=checked([ring]); near(pixel(r,.5,.5),BLUE); near(pixel(r,.1,.5),RED);
  near(r.pixels,checked([reverseFeature(ring)]).pixels,1e-6);
  const repeated={...ring,nodes:[...ring.nodes,ring.nodes[0]]};
  near(r.pixels,checked([repeated]).pixels,1e-6);
  const h=.25*4*(Math.sqrt(2)-1)/3; // Quarter-circle cubic handle length.
  const circle=feature([[.75,.5,0,-h,0,h],[.5,.75,h,0,-h,0],[.25,.5,0,h,0,-h],[.5,.25,-h,0,h,0]],RED,{closed:true,twoSided:true});
  const round=checked([circle]); near(pixel(round,.5,.5),BLUE); near(pixel(round,.1,.5),RED);
  near(round.pixels,checked([reverseFeature(circle)]).pixels,1e-6);
  const preview=solveMultipoint([ring]);
  let minimum=0; for(const value of preview.pixels) minimum=Math.min(minimum,value);
  assert.ok(preview.converged && minimum<0 && minimum>-1e-3,'bounded undershoot stays float, never silently clipped');
});

test('curves, mixed isolated sources, exact knot insertion and reversal',()=>{
  const scene=[cubic,feature([[.12,.2]],[.3,.6,.9,.6]),feature([[.8,.8]],CLEAR)];
  const original=checked(scene);
  near(original.pixels,checked([insertFeatureNode(cubic,1),...scene.slice(1)]).pixels,2e-6);
  near(original.pixels,checked([reverseFeature(cubic),...scene.slice(1)]).pixels,2e-6);
  const straight=checked([{...cubic,nodes:cubic.nodes.map(n=>[n[0],n[1],0,0,0,0])},...scene.slice(1)]);
  let change=0; for(let i=0;i<original.pixels.length;i++) change=Math.max(change,Math.abs(original.pixels[i]-straight.pixels[i]));
  assert.ok(change>.2,'canonical handles must affect field');
});

test('knot insertion stays stable for small loops and off-box handle extrema',()=>{
  /** Pure function. Deterministic fixture coordinate. @param {number} i Index. @returns {number} [0,1]. @example sample(0) // .5 */
  const sample=i=>(1+Math.sin(i*12.345))/2;
  for(const i of [33,46]) {
    const scale=i===33?.001:1;
    const nodes=Array.from({length:2+i%3},(_,j)=>[.4+scale*sample(10*i+j),.4+scale*sample(11*i+j+3),...Array.from({length:4},(_,k)=>scale*(sample(13*i+7*j+k)-.5))]);
    const f=feature(nodes,RED,{twoSided:true,closed:i%2===0,weight:10**(i%5-2),stops:[
      {offset:0,color:[1,.4,.2,.8],rightColor:[0,.3,1,1]},
      {offset:.7,color:[.1,1,.3,.4],rightColor:[1,.2,.1,.6]},
      {offset:1,color:CLEAR,rightColor:BLUE},
    ]});
    near(checked([f],64).pixels,checked([insertFeatureNode(f,1)],64).pixels,5e-6);
  }
});

test('repeated nodes and zero-length multi-node point use FIRST parsed stop',()=>{
  const repeated={...slit,nodes:[slit.nodes[0],slit.nodes[0],slit.nodes[1],slit.nodes[1]]};
  near(checked([repeated]).pixels,checked([slit]).pixels,1e-7);
  const collapsed=feature([[.5,.5],[.5,.5]],RED,{twoSided:true,stops:[{offset:0,color:RED,rightColor:BLUE},{offset:1,color:BLUE,rightColor:RED}]});
  near(pixel(checked([collapsed]),.1,.1),RED,1e-7);
  const onCenters=feature([[32.5/128,32.5/128],[96.5/128,96.5/128]],RED,{twoSided:true});
  near(checked([onCenters]).pixels,checked([reverseFeature(onCenters)]).pixels,1e-6);
  near(checked([onCenters]).pixels,checked([{...onCenters,nodes:[onCenters.nodes[0],...onCenters.nodes,onCenters.nodes[1]]}]).pixels,1e-7);
});

test('subpixel finite curves and loops remain sources, never infinite seams',()=>{
  const tiny=feature([[.5001,.5001,0,0,.00003,-.00007],[.5002,.5002,-.00004,.00006,0,0]],RED,{twoSided:true});
  const r=checked([tiny]);
  assert.ok(pixel(r,.1,.1)[3]>.999);
  assert.ok(pixel(r,.5,.49)[0]>pixel(r,.5,.51)[0]);
  near(r.pixels,checked([reverseFeature(tiny)]).pixels,1e-5);
  near(r.pixels,checked([insertFeatureNode(tiny,1)]).pixels,1e-5);
  const loop=feature([[.5,.5,0,0,.0001,-.0001],[.5,.5,-.0001,-.0001,0,0]],RED,{twoSided:true});
  const l=checked([loop]); assert.ok(pixel(l,.1,.1)[2]>.1,'tiny finite loop is not a red-only zero-length point');
  const grown={...tiny,nodes:[[.49,.5,0,0,0,0],[.51,.5,0,0,0,0]]};
  assert.ok(pixel(checked([grown],256),.5,.499)[0]>.9,'refinement uses actual finite cuts');
  const hard=feature([[.5001,.5001],[.5002,.5001]],RED,{stops:[{offset:0,color:RED},{offset:.25,color:RED},{offset:.25,color:BLUE},{offset:1,color:BLUE}]});
  near(pixel(checked([hard]),.1,.1),[.25,0,.75,1],.001);
});

test('off-box points/curves enlarge square; zero weight does not change domain',()=>{
  const f=feature([[-.5,.5],[1.5,.5]],RED,{twoSided:true});
  const r=checked([f]); assert.deepEqual(r.domain,{x:-.5,y:0,w:2,h:2});
  const normalized=feature([[0,.25],[1,.25]],RED,{twoSided:true,weight:2});
  near(r.pixels,checked([normalized]).pixels,1e-7);
  near(pixel(checked([feature([[-2,3]],[.8,.2,.4,.25])]),.5,.5),[.2,.05,.1,.25],1e-7);
  const offCurve={...cubic,nodes:[[-.5,.6,0,0,-2,-2],[1.5,.4,2,2,0,0]]};
  const off=checked([offCurve]);
  for(const [x,y] of featurePolyline(offCurve.nodes)) assert.ok(x>=off.domain.x-1e-12 && y>=off.domain.y-1e-12 && x<=off.domain.x+off.domain.w+1e-12 && y<=off.domain.y+off.domain.h+1e-12);
  const base=checked([slit]), disabled=checked([slit,feature([[-100,100]],BLUE,{weight:0})]);
  assert.deepEqual(base.domain,disabled.domain); near(base.pixels,disabled.pixels,0);
  const huge=checked([feature([[1e150,-1e150]],RED)],16); near(pixel(huge,.5,.5),RED,1e-7);
});

test('outer-boundary curves constrain only inside, with distributed colors',()=>{
  const top=feature([[0,0],[1,0]],RED,{twoSided:true});
  near(pixel(checked([top]),.5,.5),BLUE,1e-7);
  near(checked([top]).pixels,checked([reverseFeature(top)]).pixels,1e-7);
  near(pixel(checked([feature([[2,0],[2,1]],RED,{twoSided:true})]),.5,.5),BLUE,1e-7);
  const competing=checked([top,feature([[.5,.8]],RED)]);
  for(const x of [.1,.5,.9]) assert.ok(pixel(competing,x,.001)[2]>.97,'boundary source must cover its full length');
  const bent=feature([[0,0],[.5,0],[.5,.5]],RED,{twoSided:true});
  assert.ok(pixel(checked([bent]),.25,.001)[2]>.97,'boundary segment still constrains when other segments cut edges');
});

test('duplicate offsets: exact/right last wins, left limit uses first',()=>{
  const t=64.5/128;
  /** Pure function. @param {number} offset Hard edge address. @returns {object} Parsed ramp line. @example hard(.5).stops.length // 4 */
  const hard=offset=>feature([[0,.5],[1,.5]],RED,{stops:[{offset:0,color:RED},{offset,color:RED},{offset,color:BLUE},{offset:1,color:BLUE}]});
  const exact=checked([hard(t)]), before=checked([hard(t-1e-9)]), after=checked([hard(t+1e-9)]);
  near(exact.pixels,before.pixels,1e-7);
  assert.ok(pixel(after,t,.499)[0]-pixel(exact,t,.499)[0]>.4);
  console.log({hardEdgeLeft:pixel(exact,t-1/128,.499)[0],hardEdgeRight:pixel(exact,t+1/128,.499)[2]});
  // Tangential diffusion softens adjacent texels; their dominant side must agree.
  assert.ok(pixel(exact,t-1/128,.499)[0]>.5 && pixel(exact,t+1/128,.499)[2]>.5);
  const endpoint=feature([[0,.5],[1,.5]],RED,{stops:[{offset:0,color:RED},{offset:0,color:BLUE}]});
  near(pixel(checked([endpoint]),.5,.2),BLUE,1e-7);
});

test('transparent alpha is a constraint; premultiply BEFORE interpolation',()=>{
  const r=checked([feature([[.2,.5]],RED),feature([[.8,.5]],CLEAR)]);
  assert.ok(pixel(r,.2,.5)[3]>.98 && pixel(r,.8,.5)[3]<.02);
  const fade=checked([feature([[0,.5],[1,.5]],RED,{stops:[{offset:0,color:RED},{offset:1,color:CLEAR}]})]);
  for(const result of [r,fade]) for(let i=0;i<result.pixels.length;i+=4) {
    near([result.pixels[i]],[result.pixels[i+3]],1e-7); assert.equal(result.pixels[i+1],0);
  }
  const clearSide=checked([{...slit,stops:[{offset:0,color:RED,rightColor:CLEAR}]}]);
  assert.ok(pixel(clearSide,.5,.49)[3]>.97 && pixel(clearSide,.5,.51)[3]<.03);
});

test('point/curve weight is stiffness, zero removes both constraints and cuts',()=>{
  const point=feature([[.2,.5]],BLUE), other=feature([[.8,.5]],RED);
  near(checked([point,{...other,weight:0},{...slit,weight:0}]).pixels,checked([point]).pixels,0);
  const weak=checked([point,{...other,weight:.01}]), strong=checked([point,other]);
  assert.ok(pixel(strong,.8,.5)[0]>pixel(weak,.8,.5)[0]+.2);
  const weakCurve=checked([point,{...slit,weight:.001}]), strongCurve=checked([point,slit]);
  assert.ok(pixel(strongCurve,.5,.49)[0]>pixel(weakCurve,.5,.49)[0]+.1);
});

test('fixed .04 logical point support/strength stable at 128 and 256',()=>{
  const scene=[feature([[.2,.35]],RED,{weight:.4}),feature([[.8,.65]],BLUE,{weight:.7})];
  const a=checked(scene,128), b=checked(scene,256);
  let error=0;
  for(const [x,y] of [[.2,.35],[.35,.4],[.5,.5],[.65,.6],[.8,.65],[.05,.95]]) error=Math.max(error,near(pixel(a,x,y),pixel(b,x,y),.012));
  console.log({resolutionSampleError:error});
});

/**
 * Command. Freeze every input node recursively; returns same object.
 * @param {object} value Feature tree.
 * @returns {object} Frozen input.
 * @example Object.isFrozen(freeze({nodes:[[.5,.5]]})) // true
 */
function freeze(value) { if(value && typeof value==='object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('determinism, immutable inputs, no source cap and explicit incomplete result',()=>{
  const scene=freeze([cubic,...Array.from({length:24},(_,i)=>feature([[.1+(i%6)*.15,.1+Math.floor(i/6)*.25]],i%2?RED:BLUE))]);
  const before=JSON.stringify(scene), a=checked(scene,64), b=checked(scene,64);
  near(a.pixels,b.pixels,0); assert.equal(JSON.stringify(scene),before);
  const options=Object.freeze({size:64,maxIterations:1,tolerance:1e-12});
  const incomplete=solveMultipoint(scene,options); assert.equal(incomplete.converged,false); assert.equal(incomplete.iterations,1);
  assert.ok(incomplete.relativeResidual>options.tolerance && incomplete.pixels.every(Number.isFinite));
});

test('trust boundary rejects malformed/nonfinite geometry, colors and options',()=>{
  for(const scene of [null,{},[{}],[feature([])],[{...slit,stops:[]}],[{...slit,weight:-1}],[{...slit,weight:Infinity}],[{...slit,weight:null}],[{...slit,twoSided:'yes'}],
    [feature([[NaN,.5]])],[feature([[.5,.5,0,0,Infinity,0]])],[feature([[.5,.5]],[1,0,0,NaN])],[feature([[.5,.5]],[1,0,0,2])],
    [{...slit,stops:[{offset:0,color:RED}]}],[{...slit,stops:[{offset:Infinity,color:RED,rightColor:BLUE}]}],
    [{...slit,stops:[{offset:.8,color:RED,rightColor:BLUE},{offset:.2,color:RED,rightColor:BLUE}]}]]) assert.throws(()=>solveMultipoint(scene));
  for(const options of [{size:127},{size:0},{size:Infinity},{tolerance:0},{tolerance:NaN},{maxIterations:0},{maxIterations:1.5}]) assert.throws(()=>solveMultipoint([slit],options));
  assert.throws(()=>solveMultipoint([feature([[.5,.5]],RED,{weight:Number.MAX_VALUE})]),/overflow/);
  assert.throws(()=>solveMultipoint([feature([[-Number.MAX_VALUE,0],[Number.MAX_VALUE,0]])]),/domain overflow/);
});

/**
 * Pure function. Independent dense Gaussian elimination for a finite horizontal slit
 * plus cell-centered subpixel points. Assembles directly from energy, no production
 * rasterizer, multigrid or prototype import. Quadratic storage/cubic work: tiny grids.
 * @param {number} n Grid side, e.g. 16.
 * @param {object} line Horizontal parsed source with ONE constant two-sided stop.
 * @param {object[]} points Parsed points exactly at cell centers; radius .04*n < 1.
 * @returns {Float64Array} Premultiplied RGBA (n,n,4), e.g. (16,16,4).
 * @example denseReference(8,feature([[.2,.43],[.8,.43]],RED),[])[3] // approximately 1
 */
function denseReference(n,line,points) {
  const count=n*n, a=new Float64Array(count*count), b=new Float64Array(count*4);
  const [start,end]=line.nodes, cutRow=Math.floor(start[1]*n-.5), fraction=start[1]*n-.5-cutRow;
  const resistance=n/(2048*line.weight);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
    const i=y*n+x;
    for(const j of [x+1<n?i+1:-1,y+1<n?i+n:-1]) {
      if(j<0) continue;
      if(j===i+n && y===cutRow && (x+.5)/n>=start[0] && (x+.5)/n<=end[0]) {
        for(const [cell,m,color] of [[i,1/(fraction+resistance),line.stops[0].color],[j,1/(1-fraction+resistance),line.twoSided?line.stops[0].rightColor:line.stops[0].color]]) {
          a[cell*count+cell]+=m;
          for(let c=0;c<4;c++) b[4*cell+c]+=m*color[c]*(c===3?1:color[3]);
        }
      } else { a[i*count+i]++; a[j*count+j]++; a[i*count+j]--; a[j*count+i]--; }
    }
  }
  for(const point of points) {
    const [x,y]=point.nodes[0], i=Math.floor(y*n)*n+Math.floor(x*n), mass=128*point.weight, color=point.stops[0].color;
    a[i*count+i]+=mass;
    for(let c=0;c<4;c++) b[4*i+c]+=mass*color[c]*(c===3?1:color[3]);
  }
  for(let k=0;k<count;k++) for(let i=k+1;i<count;i++) {
    const factor=a[i*count+k]/a[k*count+k];
    for(let j=k+1;j<count;j++) a[i*count+j]-=factor*a[k*count+j];
    for(let c=0;c<4;c++) b[4*i+c]-=factor*b[4*k+c];
  }
  for(let i=count-1;i>=0;i--) for(let c=0;c<4;c++) {
    for(let j=i+1;j<count;j++) b[4*i+c]-=a[i*count+j]*b[4*j+c];
    b[4*i+c]/=a[i*count+i];
  }
  return b;
}

test('independently assembled dense small-grid solution agrees with PCG',()=>{
  const n=16, line=feature([[.19,.43],[.82,.43]],[.9,.3,.1,.8],{twoSided:true,weight:.015,stops:[{offset:0,color:[.9,.3,.1,.8],rightColor:CLEAR}]});
  const points=[feature([[2.5/n,4.5/n]],BLUE,{weight:.3}),feature([[12.5/n,13.5/n]],[.2,.8,.4,.4],{weight:.7})];
  const actual=solveMultipoint([line,...points],{size:n,tolerance:1e-11}); assert.ok(actual.converged);
  const error=near(actual.pixels,denseReference(n,line,points),1e-7);
  console.log({denseMaxError:error,iterations:actual.iterations});
});
