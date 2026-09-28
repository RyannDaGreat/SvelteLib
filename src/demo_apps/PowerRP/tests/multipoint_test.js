/** Native Multipoint schema/geometry/parser/document checks. Run with node. */
import assert from "node:assert/strict";
import { multipointFeature, freshMultipoint, nodeCubic, featurePolyline, pointAlongPolyline, nearestPolylineOffset, insertFeatureNode, reverseFeature, MULTIPOINT_TYPE } from "../core/multipoint.js";
import { evalCubic } from "../core/morph_geometry.js";
import { blendApplied } from "../core/deltas.js";
import { MULTIPOINT_FEATURES_LIST, MULTIPOINT_NODES_LIST } from "../core/properties.js";
import { listSlotPaths, handleElementList, withElementActive, withElementInserted, withElementPurged, withElementsOrderedBy } from "../core/lists.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { geometryLeafCoordinates, geometryPairs } from "../web/canvas/dragKinds.js";
import { equationBoundKeys, equationPinning } from "../web/canvas/equationBinding.js";
import { getPath } from "../core/deltas.js";
import { listDeclAt, listSlotKind, storedListPath, listResultProblem, evaluateState } from "../core/expressions.js";
import { parsePaint, opHasMultipointPaint, paintSolidColor } from "../render_gpu/ir.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, foldState } from "../core/document.js";

/** Command. Executes an assertion group and reports its successful completion. */
function test(name, check) { check(); console.log(`  ok  ${name}`); }
/** Pure function. Wraps features as stored paint. @param {object[]} features @returns {object} @example paint([]).type // "multipointGradient" */
function paint(features) { return { type: MULTIPOINT_TYPE, multipoint: { features } }; }
/** Command. Asserts all numeric entries agree within cubic roundoff. */
function near(a, b) { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-10, `${v} != ${b[i]}`)); }

const line = multipointFeature("line", "#f00");
const curve = multipointFeature("curve", "#ff880080");
const point = multipointFeature("point", "#00f");
const multi = paint([line, curve, point]);

test("geometry examples and realistic adaptive Bézier shape", () => {
  assert.deepEqual(line.nodes, [[0.25, 0.5, 0, 0, 0, 0], [0.75, 0.5, 0, 0, 0, 0]]);
  assert.deepEqual(nodeCubic([0,0,0,0,0.25,0], [1,1,-0.25,0,0,0]), [[0,0],[0.25,0],[0.75,1],[1,1]]);
  assert.deepEqual(featurePolyline(line.nodes), [[0.25, 0.5], [0.75, 0.5]]);
  assert.deepEqual(featurePolyline(point.nodes), [[0.5, 0.5]]);
  assert.deepEqual(featurePolyline([]), []);
  const polyline = featurePolyline(curve.nodes);
  assert.ok(polyline.length > 10 && polyline.length < 1000);
  assert.deepEqual(polyline[0], curve.nodes[0].slice(0, 2));
  assert.deepEqual(polyline.at(-1), curve.nodes.at(-1).slice(0, 2));
  assert.deepEqual(pointAlongPolyline([[0,0],[1,0],[1,1]], 0.75), {x:1,y:0.5,dx:0,dy:1});
  assert.equal(nearestPolylineOffset([[0,0],[1,0],[1,1]], {x:1.2,y:0.5}), 0.75);
  assert.equal(nearestPolylineOffset([[0.2,0.3]], {x:1,y:1}), 0);
  assert.throws(() => multipointFeature("typo"), /Unknown Multipoint/);
  assert.equal(freshMultipoint("#123456").features[0].stops[0].color, "#123456");
});

test("node insertion exactly splits the original cubic, not its colours", () => {
  const before = JSON.stringify(curve), split = insertFeatureNode(curve, 1);
  const original = nodeCubic(...curve.nodes);
  for (const t of [0, 0.1, 0.25, 0.49, 0.5, 0.75, 0.9, 1]) {
    const segment = t <= 0.5 ? nodeCubic(split.nodes[0], split.nodes[1]) : nodeCubic(split.nodes[1], split.nodes[2]);
    near(evalCubic(original, t), evalCubic(segment, t <= 0.5 ? t * 2 : t * 2 - 1));
  }
  assert.equal(split.stops, curve.stops);
  assert.equal(JSON.stringify(curve), before);
  near(insertFeatureNode(line, 1).nodes[1], [0.5,0.5,-0.125,0,0.125,0]);
  assert.equal(insertFeatureNode(point, 1).nodes.length, 2);
  const closed = { ...curve, closed: true, nodesActive: [true, true] };
  const closing = insertFeatureNode(closed, 2);
  assert.deepEqual(closing.nodesActive, [true, true, true]);
  near(closing.nodes[2].slice(0,2), evalCubic(nodeCubic(curve.nodes[1], curve.nodes[0]), 0.5));
  assert.throws(() => insertFeatureNode(curve, 4), /valid index/);
  const hidden = {...line,nodes:[[0,0,0,0,0,0],[0,1,0,0,0,0],[1,0,0,0,0,0]],nodesActive:[true,false,true]};
  const inserted = insertFeatureNode(hidden,2);
  assert.deepEqual(inserted.nodes[1],hidden.nodes[1],"hidden stored node remains untouched");
  assert.deepEqual(inserted.nodesActive,[true,false,true,true]);
  near(inserted.nodes[2].slice(0,2),[0.5,0]);
  assert.ok(featurePolyline(inserted.nodes.filter((_,i)=>inserted.nodesActive[i])).every(p=>p[1]===0),"split follows visible A–C, not hidden B–C");
  const atClosedStart = insertFeatureNode(closed,0);
  assert.deepEqual(atClosedStart.nodes,closing.nodes,"closed beginning and ending are the same seam without shifting ramp origin");
});

test("reversal keeps physical sides, colour addresses, and closed origin", () => {
  const f = { ...curve, twoSided:true, stops:[{offset:0.2,color:"#f00",rightColor:"#00f"},{offset:0.7,color:"#0f0",rightColor:"#fff"}], nodesActive:[true,false], stopsActive:[false,true] };
  const r = reverseFeature(f);
  assert.equal(r.stops[0].color, "#fff");
  assert.equal(r.stops[0].rightColor, "#0f0");
  assert.deepEqual(r.nodesActive, [false,true]);
  assert.deepEqual(r.stopsActive, [true,false]);
  assert.deepEqual(reverseFeature(r).nodes, f.nodes);
  near(reverseFeature(r).stops.map(s => s.offset), f.stops.map(s => s.offset));
  const closed = {...f, closed:true, nodesActive:[true,true]};
  assert.deepEqual(reverseFeature(closed).nodes[0].slice(0,2), closed.nodes[0].slice(0,2));
});

test("parser accepts mixed features, alpha and empty/hidden/zero-weight sources", () => {
  const parsed = parsePaint(multi);
  assert.equal(parsed.features.length, 3);
  assert.equal(parsed.features[1].stops[0].color[3], 128/255);
  assert.deepEqual(parsePaint(parsed), parsed, "parser is reentrant");
  const proxied = paint([{...line,nodes:line.nodes.map(n=>new Proxy(n,{}))}]);
  assert.deepEqual(structuredClone(parsePaint(proxied)), parsePaint(paint([line])), "IR detaches reactive tuple proxies before worker transfer");
  assert.deepEqual(parsePaint(paint([])).features, []);
  assert.deepEqual(parsePaint(paint([{...line,weight:0}])).features, []);
  assert.deepEqual(parsePaint({...multi,multipoint:{...multi.multipoint,featuresActive:[false,false,false]}}).features, []);
  assert.deepEqual(parsePaint(paint([{...line,nodesActive:[false,false]}])).features, []);
  assert.deepEqual(parsePaint(paint([{...line,stopsActive:[false]}])).features, []);
  assert.deepEqual(paintSolidColor(paint([point])), [0,0,1,1]);
  assert.equal(opHasMultipointPaint({op:"text",rich:{runs:[{text:"word",color:multi}]}}), true);
  assert.equal(opHasMultipointPaint({op:"path",stroke:{type:"crossfade",from:multi,to:"#000",t:0.4}}), true);
  const single = {...point,twoSided:true,stops:[{offset:0.8,color:"#f00"},{offset:0,color:"#00f"}]};
  assert.deepEqual(parsePaint(paint([single])).features[0].stops[0].color, [1,0,0,1], "point ignores path offset/right side");
});

test("malformed active input fails explicitly, never silent replacement paint", () => {
  assert.throws(() => parsePaint({type:MULTIPOINT_TYPE}), /features list/);
  assert.throws(() => parsePaint(paint([{...point,weight:-1}])), /weight/);
  assert.throws(() => parsePaint(paint([{...point,weight:Infinity}])), /weight/);
  assert.throws(() => parsePaint(paint([{...point,nodes:[[0,NaN,0,0,0,0]]}])), /finite/);
  assert.throws(() => parsePaint(paint([{...line,twoSided:"yes"}])), /boolean/);
  assert.throws(() => parsePaint(paint([{...line,twoSided:true,stops:[{offset:0,color:"#f00"}]}])), /unsupported color/);
});

test("nested declarations drive typed leaves, logical paths and visibility", () => {
  const path = ["fill","multipoint","features",0,"nodes",1,"outX"];
  assert.deepEqual(listDeclAt(path).decl, {name:"nodes", ...MULTIPOINT_NODES_LIST});
  assert.equal(listSlotKind(path), "number");
  assert.deepEqual(storedListPath(path), ["fill","multipoint","features",0,"nodes",1,4]);
  assert.equal(listSlotKind(["fill","multipoint","features",0,"stops",0,"rightColor"]), "color");
  assert.equal(listSlotKind(["fill","multipoint","features",0,"nodesActive",1]), "boolean");
  assert.equal(listResultProblem(MULTIPOINT_FEATURES_LIST, [curve]), null);
  assert.match(listResultProblem(MULTIPOINT_FEATURES_LIST, [{...curve,nodes:[["bad",0,0,0,0,0]]}]), /nodes.*x/);
  const paths = listSlotPaths(MULTIPOINT_FEATURES_LIST, [curve], ["fill","multipoint","features"]);
  assert.ok(paths.some(s => s.path.join(".") === "fill.multipoint.features.0.nodes.1.4"));
});

test("animation is continuous at integer endpoints, structural edits are discrete", () => {
  const a = paint([{...point,nodes:[[0,0,0,0,0,0]]}]);
  const b = paint([{...point,nodes:[[1,1,1,1,1,1]],weight:2}]);
  const mid = blendApplied({fill:a}, {fill:b}, 0.25).fill;
  assert.equal(mid.type, MULTIPOINT_TYPE, "same-kind geometry does not crossfade pictures");
  near(mid.multipoint.features[0].nodes[0], [0.25,0.25,0.25,0.25,0.25,0.25]);
  assert.equal(mid.multipoint.features[0].weight, 1.25);
  const sparse = {fill:{multipoint:{features:{0:{nodes:{0:{0:1}}}}}}};
  assert.equal(blendApplied({fill:a}, sparse, 0.25).fill.multipoint.features[0].nodes[0][0], 0.25);
  assert.equal(blendApplied({fill:a}, {fill:paint([point,curve])}, 0.25).fill.multipoint.features.length, 2);
  assert.equal(blendApplied({fill:a}, {fill:{type:"solid",solid:"#fff"}}, 0.25).fill.type, "crossfade");
  assert.equal(blendApplied({count:0}, {count:1}, 0.25).count, 0, "legacy integer law unchanged");
});

test("real fold/evaluate/reload resolves nested numeric, colour, boolean equations", () => {
  const registry = createRegistry(); registerPlugins(registry);
  const f = {...line,nodes:[["= 0.1 + 0.2",0.25,0,0,0,0],[0.75,0.75,0,0,0,0]],
    nodesActive:[true,"= true"],twoSided:"= false",weight:"= 2 / 2",
    stops:[{offset:0,color:'= "#ff0000"',rightColor:"#00f"}]};
  const doc = repairedDocument({meta:{version:1},slides:[{id:"s0",name:"One",transition:{type:"tween",seconds:0,curve:"linear"},
    delta:{items:{r:{type:"rect",x:0,y:0,w:200,h:100,fill:paint([f])}}}}]}, registry).doc;
  const restored = JSON.parse(JSON.stringify(doc));
  const result = evaluateState(foldState(restored,0,1), registry);
  assert.deepEqual([...result.errors.values()], []);
  const parsed = parsePaint(result.state.items.r.fill);
  assert.ok(Math.abs(parsed.features[0].nodes[0][0] - 0.3) < 1e-12);
  assert.deepEqual(parsed.features[0].stops[0].color, [1,0,0,1]);
  assert.equal(parsed.features[0].twoSided, false);
  assert.equal(parsed.features[0].weight, 1);
});
test("native handles have independent anchors, controls, colour stops and nested targets", () => {
  const state = {w:240,h:80,fill:paint([curve,point])};
  const handles = paintModifierPoints(state);
  const anchor = handles.find(h => h.id === "fill-mp-0-node-0");
  assert.deepEqual(handleElementList(anchor).listPath, ["fill","multipoint","features",0,"nodes"]);
  assert.deepEqual(handleElementList(anchor).activePath, ["fill","multipoint","features",0,"nodesActive"]);
  assert.ok(anchor.guide.length > 10);
  const moved = anchor.apply(state,{x:120,y:20});
  near(moved.fill.multipoint.features[0].nodes[0], [0.5,0.25,0,0,0.2,-0.5]);
  assert.equal(moved.fill.multipoint.features[0].stops, curve.stops);
  const control = handles.find(h => h.id.endsWith("node-0-outgoing"));
  assert.equal(control.element, undefined, "subhandle is not a duplicate purge target");
  const bent = control.apply(state, {x:144,y:12});
  near(bent.fill.multipoint.features[0].nodes[0], [0.2,0.65,0,0,0.4,-0.5]);
  const stop = handles.find(h => h.id === "fill-mp-0-stop-0");
  assert.equal(stop.apply(state, stop).fill.multipoint.features[0].stops[0].offset, 0);
  assert.ok(!handles.some(h => h.id === "fill-mp-1-stop-0"), "singleton has no fake path offset");
  const broken = {...state,fill:paint([{...curve,nodesActive:[false,true]}])};
  assert.equal(paintModifierPoints(broken)[0].active, false);
  assert.ok(!paintModifierPoints(broken).some(h => h.id.includes("stop")));
  assert.equal(handleElementList({id:"scalar"}), null);
  assert.throws(() => handleElementList({id:"bad",element:{list:{},index:0}}), /list declaration/);
});

test("source handles carry real swatches and independent left/right picker paths", () => {
  const f = {...line,twoSided:true,stops:[{offset:0.5,color:"#f008",rightColor:"#00f"}]};
  const state = {w:200,h:100,fill:paint([f,point])};
  const handles = paintModifierPoints(state);
  const left = handles.find(h => h.id === "fill-mp-0-stop-0");
  const right = handles.find(h => h.id === "fill-mp-0-stop-0-right");
  assert.ok(left.y < 50 && right.y > 50, "screen-left of a rightward path is above");
  assert.equal(left.x,right.x);
  assert.equal(left.colorPath.at(-1),"color");
  assert.equal(right.colorPath.at(-1),"rightColor");
  assert.notEqual(left.color,right.color);
  const anchored = handles.find(h => h.id === "fill-mp-1-node-0");
  assert.deepEqual(anchored.colorPath,["fill","multipoint","features",1,"stops",0,"color"]);
  assert.equal(right.apply(state,right).fill.multipoint.features[0].stops[0].offset,0.5);
});

test("modifier writes change only touched leaves and respect whole-paint equations", () => {
  const original = {fill:multi};
  const desired = {fill:paint([line,{...curve,nodes:[[0.4,0.65,0,0,0.2,-0.5],curve.nodes[1]]},point])};
  const leaves = geometryLeafCoordinates(original,desired);
  const pairs = geometryPairs("r", leaves.start, leaves.desired);
  assert.deepEqual(pairs, [[["items","r","fill","multipoint","features","1","nodes","0","0"],0.4]]);
  const raw = {fill:{...multi,multipoint:{features:[line,{...curve,nodes:[["= 0.2",0.65,0,0,0.2,-0.5],curve.nodes[1]]},point]}}};
  const app = {storedItemValue: (_id,path) => getPath(raw,path)};
  assert.deepEqual(geometryPairs("r",leaves.start,leaves.desired,equationPinning(app,"r",{})), []);
  const whole = {storedItemValue: (_id,path) => path.length === 1 ? "= other.fill" : undefined};
  assert.deepEqual(equationBoundKeys(whole,"r",{},["fill.multipoint.features.1.nodes.0.0"]),["fill.multipoint.features.1.nodes.0.0"]);
  assert.deepEqual(geometryLeafCoordinates({p:[[0,2]]},{p:[[1,2]]}), {start:{"p.0.0":0,"p.0.1":2},desired:{"p.0.0":1,"p.0.1":2}});
});

test("list structural edits preserve raw equations and sparse visibility", () => {
  const value = {list:[[0,0,0,0,0,0],[1,1,0,0,0,0],[2,2,0,0,0,0]],active:{1:"= false",2:false}};
  assert.deepEqual(withElementActive(MULTIPOINT_NODES_LIST,value,0,false).active, [false,"= false",false]);
  assert.deepEqual(withElementPurged(MULTIPOINT_NODES_LIST,value,0).active, ["= false",false]);
  assert.deepEqual(withElementInserted(MULTIPOINT_NODES_LIST,value,1).active,[true,true,"= false",false]);
  assert.deepEqual(withElementsOrderedBy(value,[2,1,0]).active,[false,"= false",true]);
});
console.log("PASS — native Multipoint geometry, schema, parser, document and handle checks");
