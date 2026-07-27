/**
 * Wave 2 test — the unified `path` op + preset-shape library end to end, in bare
 * node (CanvasKit CPU surface). Proves:
 *   - core/shapes.js generators produce valid path `d` for every preset, and the
 *     doctest example values hold (spot asserts),
 *   - a `path` IR op (a star) rasterizes through the SAME Skia backend the editor
 *     uses → a non-trivial PNG (with fill + stroke + evenodd),
 *   - every preset's `d` round-trips through svg_backend (native <path>) AND
 *     pdf_backend's svgPathToPdfOps (no arc/`A` — the PDF-safe grammar), so a
 *     shape exports as real vector to both,
 *   - the shape PLUGIN emits exactly one path op for a default (effects-off) state.
 *
 * Run: node render_gpu/tests/skia_shapes_test.js   (from the PowerRP dir)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import assert from "assert";
import { renderToPng } from "../skia/node_render.js";
import { path as pathOp, rect } from "../ir.js";
import { vectorCommandToSVG } from "../svg_backend.js";
import { svgPathToPdfOps } from "../pdf_backend.js";
import { SHAPE_NAMES, SHAPE_LABELS, shapePath } from "../../core/shapes.js";
import { shapePlugin } from "../../plugins/shape.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude_vlm_checks", "skia_shapes_test.png");
const DPR = 2;
const LOGICAL_W = 760, LOGICAL_H = 520;

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log(`  ok  ${name}`); n++; };

// ── 1. shapes.js doctest spot-checks ──────────────────────────────────────────
ok("shapePath diamond exact", shapePath("diamond", 100, 100) === "M50 0 L100 50 L50 100 L0 50 Z");
ok("shapePath star 5 → 10 vertices", shapePath("star", 100, 100).split("L").length === 10);
ok("shapePath star points=6 → 12 vertices", shapePath("star", 100, 100, { points: 6 }).split("L").length === 12);
ok("cross exact", shapePath("cross", 90, 90) === "M30 0 L60 0 L60 30 L90 30 L90 60 L60 60 L60 90 L30 90 L30 60 L0 60 L0 30 L30 30 Z");
ok("17 presets registered", SHAPE_NAMES.length === 17 && SHAPE_NAMES.every((k) => SHAPE_LABELS[k]));
assert.throws(() => shapePath("nope", 10, 10), /unknown shape/, "unknown preset throws");
ok("unknown preset throws loudly", true);

// ── 2. every preset round-trips through BOTH vector backends ───────────────────
const world = { x: 0, y: 0, rotation: 0, scale: 1 };
for (const name of SHAPE_NAMES) {
  const d = shapePath(name, 120, 90, { points: 5, innerRatio: 0.45 });
  assert.ok(typeof d === "string" && d.startsWith("M"), `${name}: valid d`);
  // SVG: a native <path d=…> with the d embedded.
  const svg = vectorCommandToSVG(pathOp({ d, fill: "#4f8cff", stroke: "#12234a", strokeWidth: 3 }), world, {});
  assert.ok(svg.includes("<path") && svg.includes(`d="${d}"`), `${name}: svg <path>`);
  // PDF: svgPathToPdfOps must not throw (proves the d uses only PDF-safe commands
  // — M L H V C S Q T Z, never an arc) and yields path operators.
  const pdf = svgPathToPdfOps(d);
  assert.ok(/[ml]$|c$|[ml]\n|c\n/m.test(pdf) && pdf.length > 0, `${name}: pdf ops`);
}
ok(`all ${SHAPE_NAMES.length} presets export to SVG <path> + PDF ops (PDF-safe grammar)`, true);

// evenodd fill rule surfaces in both backends.
const holed = pathOp({ d: "M0 0h20v20h-20zM5 5h10v10h-10z", fill: "#000", fillRule: "evenodd" });
ok("svg emits fill-rule=evenodd", vectorCommandToSVG(holed, world, {}).includes(`fill-rule="evenodd"`));

// ── 3. the shape PLUGIN emits ONE path op (effects off → pass-through) ─────────
const st = { ...shapePlugin.defaults, shape: "star", w: 200, h: 200 };
const emitted = shapePlugin.emit(st, null, world);
ok("plugin emits a single op", emitted.length === 1);
ok("plugin emits a path op", emitted[0].op === "path");
ok("plugin path carries fill + stroke", Array.isArray(emitted[0].fill) && Array.isArray(emitted[0].stroke));

// ── 4. rasterize a star `path` op (fill+stroke) + an evenodd holed path → PNG ──
const commands = [
  pathOp({ d: shapePath("star", 260, 260), fill: "#f59e42", stroke: "#7a3d10", strokeWidth: 6 }),
  // side-by-side reference rect so the PNG is visibly a scene, not a lone glyph.
  rect({ x: 300, y: 30, w: 180, h: 120, cornerRadius: 14, fill: "#4f8cff", stroke: "#12234a", strokeWidth: 4 }),
  pathOp({ d: shapePath("heart", 200, 200), fill: "#e0567a" }),
  pathOp({ d: "M520 40h180v180h-180zM560 80h100v100h-100z", fill: "#22a06b", fillRule: "evenodd" }),
];
const png = await renderToPng(commands, { zoom: 1, panX: 0, panY: 0, dpr: DPR }, {
  width: LOGICAL_W * DPR, height: LOGICAL_H * DPR, background: "#ffffff",
});
ok("star + heart + evenodd path render to a non-trivial PNG", png instanceof Uint8Array && png.length > 1000);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(png));

console.log(`\n${n} shape/path checks passed — wrote ${OUT} (${png.length} bytes)`);
