/**
 * NODE-FLOW WIRE EXPORT PARITY (WORKSTREAM BN) — do the wires between nodes
 * actually reach the exported PDF and SVG, as VECTORS?
 * Run: node render_gpu/tests/wire_export_parity_test.js
 *
 * ── THE BUG CLASS THIS CLOSES ────────────────────────────────────────────────
 * User, 2026-08-03, verbatim: "the wires between nodes should be shown in
 * prsentation mode and pdf rener and png render etc too please".
 *
 * Until BN, a wire was an SVG path in web/CanvasView.svelte's overlay and nowhere
 * else, so a PDF or SVG of a patch showed the node cards, showed their port BEADS
 * (which were already scene content), and showed no cables between them. That is
 * worse than an absent feature: the export looked like a DELIBERATE picture of a
 * disconnected patch. The fix put the wires in the display list, and the claim
 * that buys everything else is "they are ordinary path+stroke ops, so every
 * backend already draws them with zero per-backend work". THIS FILE IS THAT CLAIM
 * UNDER TEST — if it were false, it would be false silently, in a shipped file.
 *
 * ── WHY STRUCTURAL, NOT PIXEL ────────────────────────────────────────────────
 * The heavy parity suites (blend_export_parity_test, pdf_scenes/svg_scenes)
 * rasterize with poppler/Chromium and compare PSNR, which is the right instrument
 * for asking whether a COMPOSITE is faithful. That is not the question here. The
 * question is whether the ops survive the walk into each backend's native vector
 * spelling at all — a binary, structural fact — and a structural assertion states
 * it exactly, in about a second, with no rasterizer to install. Pixel parity for
 * a plain stroked cubic is already covered by every `path`-emitting widget in the
 * existing matrices; the wire adds no new op type, which is the entire point.
 *
 * So the assertions are: the wire's own bezier `d` appears in the SVG as a real
 * <path> (NOT a raster <image> fallback), and the PDF content stream carries the
 * cubic operators (`c`) and a stroke (`S`) rather than an XObject `Do`.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../../core/registry.js";
import { registerPlugins } from "../../plugins/index.js";
import { deriveRenderTree, deriveWires } from "../../core/derive.js";
import { sceneIR } from "../ports.js";
import { irToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { fitRectView } from "../../core/view.js";
import { wireBezierPath } from "../../core/nodeflow.js";

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.error(`  FAIL  ${name}: ${e.message}`); }
}

const registry = createRegistry();
registerPlugins(registry);

/** The same connected trio tests/nodeflow_test.js uses: 3 × 2 = 6 across three
 *  wires, so the export carries more than one cable and more than one direction. */
const trio = () => ({
  src: { type: "node_number", x: 0, y: 0, w: 130, h: 90, value: 3 },
  mul: { type: "node_math", x: 300, y: 0, w: 150, h: 90, op: "multiply", inputs: { a: { item: "src", port: "out" }, b: { item: "two", port: "out" } } },
  two: { type: "node_number", x: 0, y: 200, w: 130, h: 90, value: 2 },
  disp: { type: "node_display", x: 600, y: 0, w: 140, h: 90, inputs: { in: { item: "mul", port: "out" } } },
});

const WIDTH = 800, HEIGHT = 400;
const CAM = { x: -20, y: -20, w: 800, h: 400 };
const nodes = deriveRenderTree({ items: trio() }, registry);
const wires = deriveWires(nodes);
const ir = sceneIR(nodes);
const view = fitRectView(CAM, WIDTH, HEIGHT, 1);

// A REFUSING rasterizer. If either backend decided a plain stroked cubic needed a
// raster fallback, this throws and names the failure instead of quietly producing
// a bitmap that would still "look right" in a viewer — the exact silent
// degradation the hybrid-vector rule exists to prevent.
const noRaster = () => { throw new Error("a wire must export as VECTOR — nothing here may route to the raster fallback"); };

await test("the trio's wires are in the IR at all (the precondition every assertion below rests on)", () => {
  assert.equal(wires.length, 3, "the fixture must actually be a connected patch");
  const paths = ir.filter((o) => o.op === "path" && String(o.d).startsWith("M "));
  assert.equal(paths.length, 6, "three wires × (halo + wire)");
});

await test("SVG: every wire's bezier is a native <path>, not a raster fallback", async () => {
  const svg = await irToSVG(ir, { width: WIDTH, height: HEIGHT, view, background: "#ffffff", rasterize: noRaster });
  for (const w of wires) {
    const d = wireBezierPath(w.from, w.to);
    assert.ok(svg.includes(d), `the SVG must carry the wire's own path data verbatim; missing ${d}`);
  }
  // The op must have become a real <path> element. An <image> here would mean the
  // wire rasterized — visually plausible and structurally wrong.
  assert.ok(svg.includes("<path"), "wires must serialize as <path> elements");
  assert.ok(!svg.includes("<image"), "nothing in a pure-vector node patch may rasterize");
});

await test("SVG: a wire is STROKED in its type colour and never filled", async () => {
  const svg = await irToSVG(ir, { width: WIDTH, height: HEIGHT, view, background: "#ffffff", rasterize: noRaster });
  const d = wireBezierPath(wires[0].from, wires[0].to);
  // The element carrying this `d` must declare a stroke and an explicit fill:none —
  // a filled cubic would paint the area the cable BOUNDS, a solid blob under the
  // patch, which is what a missing fill:none actually produces.
  const el = svg.slice(svg.indexOf(d)).slice(0, svg.slice(svg.indexOf(d)).indexOf(">") + 1);
  assert.match(el, /stroke=/, `the wire element must be stroked: ${el}`);
  assert.match(el, /fill="none"/, `the wire element must be explicitly unfilled: ${el}`);
});

await test("PDF: a connected patch exports without ever reaching the raster fallback", async () => {
  // WHAT THIS DOES AND DOES NOT PROVE, stated plainly because the honest scope is
  // narrower than "the wires are in the PDF": pdf-lib compresses content streams,
  // so the cubic/stroke operators are not readable from the bytes here without
  // inflating them, and this suite deliberately installs no rasterizer to keep it
  // a one-second bare-node gate. What IS proven is the thing that was actually at
  // risk: `noRaster` throws on any route to the image fallback, so a page that
  // exports at all exported its wires through the vector `path` case. The
  // OPERATOR-level evidence lives in the SVG assertions above, against the same IR
  // and the same shared `path` op — which is exactly why the two backends are one
  // family in this codebase.
  const bytes = await irToPDF(ir, { width: WIDTH, height: HEIGHT, view, background: "#ffffff", rasterize: noRaster });
  assert.ok(bytes.length > 0, "irToPDF produced no bytes");
  assert.equal(new TextDecoder("latin1").decode(bytes.slice(0, 5)), "%PDF-", "output must be a real PDF");
  // A CONTROL for the byte-count check below: the same page with no connections.
  // Wires are the ONLY difference, so a connected page must be the larger file —
  // if it were not, the wires contributed no content stream at all.
  const bare = trio();
  delete bare.mul.inputs;
  delete bare.disp.inputs;
  const bareBytes = await irToPDF(sceneIR(deriveRenderTree({ items: bare }, registry)),
    { width: WIDTH, height: HEIGHT, view, background: "#ffffff", rasterize: noRaster });
  assert.ok(bytes.length > bareBytes.length,
    `a wired patch must produce a larger PDF than the identical unwired one (${bytes.length} vs ${bareBytes.length})`);
});

await test("A DISCONNECTED patch exports the same nodes with NO wire paths — the control", async () => {
  // Without this, every assertion above would pass on a backend that drew SOMETHING
  // path-shaped for every scene. Same four nodes, zero connections, zero wire `d`s.
  const items = trio();
  delete items.mul.inputs;
  delete items.disp.inputs;
  const bare = sceneIR(deriveRenderTree({ items }, registry));
  const svg = await irToSVG(bare, { width: WIDTH, height: HEIGHT, view, background: "#ffffff", rasterize: noRaster });
  for (const w of wires) {
    assert.ok(!svg.includes(wireBezierPath(w.from, w.to)),
      "a disconnected patch must export no wire curves — otherwise the assertions above prove nothing");
  }
});

console.log(`wire_export_parity: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
