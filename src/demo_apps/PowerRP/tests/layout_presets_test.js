/**
 * THE LAYOUT/FRAME PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/layout_presets_test.js
 *
 * Covers `bento`, `group` (two families) and `camera` (one). Structural template:
 * tests/arrow_presets_test.js; sibling: tests/shape_presets_test.js.
 *
 * ── WHY THIS FILE NEEDS FIXTURES AND ITS SIBLING DOES NOT ────────────────────
 * A polygon draws its own ink, so a preset either moves its own pixels or it does
 * not. TWO OF THESE THREE PAINT NOTHING OF THEIR OWN, so their distinctness is
 * conditional on the document, and a probe that forgets the condition reports the
 * whole family dead and is RIGHT to. Each fixture below states its condition, and
 * each was got wrong once while writing this file:
 *
 *   `group` needs MEMBERS — emit() returns [] for an empty membersIR — and it
 *     needs TWO further things nobody wrote down. (a) THE CANVAS MUST BE BIGGER
 *     THAN THE GROUP, or the shadow/bloom/soft-edge spill is clipped away by the
 *     canvas edge and every outside-the-silhouette treatment measures near zero.
 *     (b) THE MEMBERS MUST REACH THE GROUP'S BBOX EDGES, or a crop inset bites
 *     nothing and all five mattes measure EXACTLY zero — which is what happened,
 *     and it is also the truthful case, since a real group's bbox IS the
 *     collective AABB of its members. The members also OVERLAP, because the whole
 *     subject of the treatment family is that the effect applies to the union
 *     silhouette rather than per member.
 *   `camera` needs a WIDE SMOOTH GRADIENT (a dither pass has nothing to act on
 *     over a flat fill) AND a DIAGONAL edge (coverage anti-aliasing changes
 *     nothing along an axis-aligned one). The gradient is the repo's own banding
 *     torture test, lifted from tests/dither_vlm_check.js — a near-black ~10-level
 *     ramp that quantises into wide hard bands with dither off. A shallower ramp
 *     under-reports the whole family.
 *   `bento` is the easy one: it strokes a rect per visible cell, so it tests like
 *     an ordinary widget.
 *
 * ── WHAT IT PROVES ───────────────────────────────────────────────────────────
 *  1. No two presets in a family render the same picture, and none renders the
 *     same picture as the widget's UNTOUCHED DEFAULT (ledger C-16).
 *  2. Every preset in a family writes the IDENTICAL key set — the overlay
 *     contract. For `bento` that is what forces `spans: []` onto the nine grids
 *     that merge nothing: without it, a rule-of-thirds picked after a hero tile
 *     inherits the hero's 2x2 merge and is not a grid system at all.
 *  3. EVERY group preset makes groupFoldsSubtree TRUE. An effect-free, uncropped
 *     group is a pure ghost, so a preset that left every knob at its identity
 *     would not be a dull row, it would be a BLANK one. Cheaper and sharper than
 *     a screenshot, and it runs before a pixel is drawn.
 *
 * ── BOUNDS: TWO MEASURED ANCHORS EACH, and the reduction chosen per family ────
 * `litSetDistance` for the two families whose subject inks a stable share of the
 * frame; `imageDistance` for the camera, whose knobs modify the WHOLE frame and
 * whose one large lever (coverage anti-aliasing) lives entirely in a 0.6% sliver
 * of edge pixels that no averaging can rescue — which is why maxAbs is printed.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, imageDistance, litSetDistance } from "./imageDistinctness.js";
import { rect, ellipse, polygon, parsePaint } from "../render_gpu/ir.js";
import { fitRectView } from "../core/view.js";
import { presetFamiliesOf } from "../core/registry.js";
import { groupFoldsSubtree } from "../plugins/group.js";
import { builtinRoster } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const roster = builtinRoster();
const get = (type) => {
  const p = roster.find((r) => r.type === type);
  assert.ok(p, `${type} is not registered`);
  return p;
};

/** Query (renders). Pairwise-compares a labelled frame set and asserts a floor,
 *  printing the narrowest pair so an author sees two rows converging before they
 *  collide. */
function assertPairwise(label, frames, distance, bound, metric, anchors) {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = distance(frames[i].png, frames[j].png);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= bound,
        `${label}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(3)} ${metric} levels apart (< ${bound}) — the same row twice. Bound calibrated: ${anchors}`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  ${metric} mean=${narrowest.d.meanAbs.toFixed(3)} max=${narrowest.d.maxAbs}` +
    (narrowest.d.coverage === undefined ? "" : ` lit=${(narrowest.d.coverage * 100).toFixed(1)}%`));
}

// ── bento ────────────────────────────────────────────────────────────────────
{
  const bento = get("bento");
  const presets = presetFamiliesOf(bento).flatMap((f) => f.presets);
  assert.ok(presets.length > 0, "bento declares no presets — every assertion below would be vacuous");

  const W = 300, H = 200;
  const view = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  const blank = readPng(await renderToPng([], view, { width: W, height: H }));
  const base = { ...bento.defaults, x: 0, y: 0, w: W, h: H };
  const shot = async (props) => readPng(await renderToPng(bento.emit({ ...base, ...props }), view, { width: W, height: H }));

  const frames = [{ name: "(DEFAULT)", png: await shot({}) }];
  for (const p of presets) frames.push({ name: p.name, png: await shot(p.props) });

  test(`bento: ${presets.length} grids and the default all render a DIFFERENT picture`, () => {
    // 13.65 — a 3x3 at gutter 9 against the same at gutter 10. A REAL COLLISION:
    //         one grid, one unit of gutter apart. The guide is a 1.5-unit stroke,
    //         so a thin subject makes a one-unit shift read high; the bound has to
    //         clear it.
    // 27.80 — the default 2x3 against Shokado Bento's 2x2, the narrowest KEEP.
    assertPairwise("bento", frames, (a, b) => litSetDistance(a, b, blank), 20, "lit-set",
      "reject 13.65 (3x3 gutter 9 vs 10) / keep 27.80 (DEFAULT vs Shokado Bento)");
  });
}

// ── group ────────────────────────────────────────────────────────────────────
{
  const group = get("group");
  const MX = 70, MY = 60, GW = 260, GH = 200;   // margin for the spill, then the group
  const CW = GW + 2 * MX, CH = GH + 2 * MY;
  const view = fitRectView({ x: 0, y: 0, w: CW, h: CH }, CW, CH);
  const BACKDROP = "#6d6d78";                    // a blend mode needs something to composite AGAINST
  // Three OVERLAPPING members in ABSOLUTE world coords, reaching all four bbox
  // edges. See the header for why both properties are load-bearing.
  const members = [
    rect({ x: MX, y: MY, w: 150, h: 130, fill: "#e0af68", stroke: null, strokeWidth: 0 }),
    ellipse({ cx: MX + 180, cy: MY + 80, rx: 80, ry: 80, fill: "#7aa2f7", stroke: null, strokeWidth: 0 }),
    polygon({ points: [[MX + 20, MY + 120], [MX + 240, MY + 110], [MX + 130, MY + 200]], fill: "#9ece6a", stroke: null, strokeWidth: 0 }),
  ];
  const world = { x: MX, y: MY, rotation: 0, scale: 1 };
  const base = { ...group.defaults, x: MX, y: MY, w: GW, h: GH };
  const blank = readPng(await renderToPng([], view, { width: CW, height: CH, background: BACKDROP }));
  const shot = async (props) =>
    readPng(await renderToPng(group.emit({ ...base, ...props }, members, world), view, { width: CW, height: CH, background: BACKDROP }));

  // The matte family writes `=` EQUATIONS on the group's own extents (the insets
  // are absolute canvas units, so a literal would be right at one size only), and
  // this suite renders states, not documents. Evaluating them the way the app does
  // needs a folded document; resolving `Math.abs(self.<axis>) * k` against this
  // fixture's own w/h is the same arithmetic and keeps the suite in bare node.
  const EQUATION = /^=\s*Math\.abs\(self\.([wh])\)\s*\*\s*([0-9.]+)$/;
  /** Pure function. A matte preset's props with its self-relative equations resolved
   *  against one concrete box.
   *  @example resolvedInsets({cropTop: "= Math.abs(self.h) * 0.5", cropLeft: 0}, 200, 100) // {cropTop: 50, cropLeft: 0}
   */
  const resolvedInsets = (props, w, h) => Object.fromEntries(Object.entries(props).map(([key, value]) => {
    if (typeof value !== "string") return [key, value];
    const m = EQUATION.exec(value);
    assert.ok(m, `group matte "${key}" = ${JSON.stringify(value)} is not the self-relative form this suite resolves`);
    return [key, Math.abs(m[1] === "w" ? w : h) * Number(m[2])];
  }));

  for (const family of presetFamiliesOf(group)) {
    assert.ok(family.presets.length > 0, `group/${family.id} declares no presets`);
    const resolve = (props) => (family.id === "presets.matte" ? resolvedInsets(props, GW, GH) : props);
    const frames = [{ name: "(DEFAULT)", png: await shot({}) }];
    for (const p of family.presets) frames.push({ name: p.name, png: await shot(resolve(p.props)) });

    test(`group/${family.id}: ${family.presets.length} presets and the default all render a DIFFERENT picture`, () => {
      // treatments: 0.39 — the Cut Paper shadow against dy 4 / blur 7 / opacity
      //             0.37, a REAL COLLISION; keep 1.49 — the default against Cut
      //             Paper itself, whose tight contact shadow is a thin band around
      //             a large filled silhouette and so measures low while reading
      //             immediately on the contact sheet.
      // mattes:     0.52 — a letterbox at 0.12 against 0.125, a REAL COLLISION;
      //             keep 9.03 — Hairline Trim against Letterbox.
      const bound = family.id === "presets.matte" ? 4 : 0.9;
      const anchors = family.id === "presets.matte"
        ? "reject 0.52 (letterbox 0.12 vs 0.125) / keep 9.03 (Hairline Trim vs Letterbox)"
        : "reject 0.39 (Cut Paper vs dy4/blur7/0.37) / keep 1.49 (DEFAULT vs Cut Paper)";
      assertPairwise(`group/${family.id}`, frames, (a, b) => litSetDistance(a, b, blank), bound, "lit-set", anchors);
    });
  }

  test("EVERY group preset folds the member subtree — a non-folding group renders NOTHING", () => {
    for (const family of presetFamiliesOf(group))
      for (const preset of family.presets) {
        const props = family.id === "presets.matte" ? resolvedInsets(preset.props, GW, GH) : preset.props;
        assert.ok(groupFoldsSubtree({ ...base, ...props }),
          `group/${family.id} "${preset.name}" leaves every knob at its identity, so the group stays a pure ghost and the preset draws a blank frame`);
      }
  });
}

// ── camera ───────────────────────────────────────────────────────────────────
{
  const camera = get("camera");
  const presets = presetFamiliesOf(camera).flatMap((f) => f.presets);
  assert.ok(presets.length > 0, "camera declares no presets — every assertion below would be vacuous");

  const W = 400, H = 600;
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };  // world == device px, as dither_vlm_check does
  const scene = [
    rect({ x: 0, y: 0, w: W, h: H, fill: parsePaint({ type: "linearGradient", linear: {
      stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#0a0a12" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } } }) }),
    polygon({ points: [[20, 560], [380, 60], [380, 560]], fill: "#c8d0e0", stroke: null, strokeWidth: 0 }),
    ellipse({ cx: 110, cy: 110, rx: 70, ry: 55, fill: "#e0af68", stroke: "#1a1a1a", strokeWidth: 2 }),
  ];
  const shot = async (s) => readPng(await renderToPng(scene, view, { width: W, height: H, background: "#000000",
    antialias: s.antialias === "standard", dither: { mode: s.ditherMode, emphasis: s.ditherEmphasis } }));

  const frames = [{ name: "(DEFAULT)", png: await shot(camera.defaults) }];
  for (const p of presets) frames.push({ name: p.name, png: await shot({ ...camera.defaults, ...p.props }) });

  test(`camera: ${presets.length} render profiles and the default all render a DIFFERENT picture`, () => {
    // 0.055 — the default against a blueNoise dither at emphasis 0.35. A REAL
    //         COLLISION and a preset that WAS designed and is cut: one code value
    //         on a tenth of the frame is the display floor, and a row whose only
    //         claim is that you cannot see it is a dead row.
    // 0.181 — Heavy Ordered Screen against Photocopy, the narrowest KEEP. They
    //         differ ONLY in coverage anti-aliasing, which lives in 0.6% of the
    //         pixels — hence the low mean and the maxAbs of 115 beside it.
    assertPairwise("camera", frames, imageDistance, 0.12, "whole-frame",
      "reject 0.055 (blueNoise emphasis 0.35 vs off) / keep 0.181 (Heavy Ordered Screen vs Photocopy)");
  });
}

test("EVERY preset in a family writes the IDENTICAL key set", () => {
  // The overlay contract. It is what forces `spans: []` onto the nine bento grids
  // that merge nothing, and `ditherEmphasis` onto the two camera profiles where
  // it is inert.
  for (const type of ["bento", "group", "camera"])
    for (const family of presetFamiliesOf(get(type))) {
      const sets = new Set(family.presets.map((p) => Object.keys(p.props).sort().join(",")));
      assert.equal(sets.size, 1, `${type}/${family.id} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
    }
});

console.log(`\n${passed} layout preset tests passed`);
