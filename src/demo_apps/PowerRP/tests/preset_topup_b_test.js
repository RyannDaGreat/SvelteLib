/**
 * PRESET TOP-UP BATCH B — brace_curly / brace_square / filmstrip / iris_blades
 * (R7-39 presets law: >= 10 rows per widget). Bare node, real Skia, real pixels
 * where pixels are the honest tool; drawn GEOMETRY where measurement showed
 * they are not (see the FILMSTRIP section below).
 *
 * WHAT THIS FILE PROVES, per family:
 *   (1) COUNT — presets.length >= 10.
 *   (2) DISTINCTNESS INCLUDING THE DEFAULT (ledger C-16) — the untouched widget
 *       is folded into every family's sweep as "(DEFAULT)", because a preset
 *       identical to it is a dead row no preset-vs-preset comparison alone can
 *       catch.
 *   (3) KEY-SET UNIFORMITY — every preset in a family writes the same prop
 *       keys, so hovering one after another cannot leak a value the new row
 *       never mentions (the rect.js / labeled_circle.js identity law).
 *
 * brace_curly/brace_square ALSO already run under tests/arrow_presets_test.js
 * (they satisfy that file's CONNECTOR filter: `editPoints && moveBy &&
 * closestToward`), which pins the whole five-connector-family bound
 * (MIN_SEPARATION 10, calibrated against arrow's own measured collision/
 * distinction pair). That file is the authority for connector-vs-connector
 * calibration; this file re-runs the SAME litSetDistance metric on the brace
 * family alone so its own floor is measured and stated here rather than only
 * inherited, and because the brace roster changed in this batch (5 -> 11 rows
 * per type) and deserves its own recorded number.
 *
 * ── WHY BRACE AND IRIS_BLADES USE PIXELS, AND FILMSTRIP DOES NOT ────────────
 * MEASURED, not assumed. litSetDistance restricted to the lit set (the pixels
 * either candidate touches, against a blank canvas) is the right tool for a
 * THIN-STROKE or FILLED-SHAPE family — brace is a hairline connector (this
 * file's header note, and tests/arrow_presets_test.js's, both name that case
 * explicitly) and iris_blades is a filled, stroked disc assembly. Both show
 * real, well-separated pairwise means once measured (see MIN_SEPARATION below
 * for each).
 *
 * Filmstrip is different in kind: two presets that differ ONLY in perforation
 * PULLDOWN (hole count/pitch) at the same base colour paint the SAME solid
 * bands and the SAME content-strip fill, and differ only at the sparse
 * boundaries of a few dozen small holes. MEASURED on this file's own 480x90
 * rig: "3-perf 35 mm negative" vs "Techniscope — 2-perf 35 mm" (both
 * `colorNegative`, differing only in pulldown) land at litSetDistance
 * meanAbs 1.62 — a real, visible difference (maxAbs 90) diluted by a lit
 * region that is 41% of the frame and mostly identical between the two. A
 * floor set to catch that pair honestly would sit near 1, which gates
 * essentially nothing; a floor set where colour differences cleanly separate
 * (>= 9.4, measured) would silently readmit the pulldown-only pairs as
 * "the same row twice". Neither number is an honest single floor for this
 * family under a whole-frame-adjacent pixel metric, so filmstrip's
 * distinctness here is measured in DRAWN GEOMETRY instead (perforation
 * along/across/radius/pitch, band thickness, colour, sides) — the same
 * quantity tests/filmstrip_test.js's own "no two presets draw the SAME holes"
 * gate already measures, extended to cover the DEFAULT (which that gate does
 * not fold in) so C-16 is checked for this family too.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { bracePlugins } from "../plugins/brace.js";
import { irisBladesPlugin } from "../plugins/iris_blades.js";
import { filmstripPlugin, filmstripGeom } from "../plugins/filmstrip.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// ── §1 BRACE (brace_curly, brace_square) ─────────────────────────────────────
// A connector: no bbox, three world points (from/to/tip). Mid-grey backdrop —
// same reasoning as rect_presets_test.js: neither favours a light nor a dark
// stroke colour, and none of this family's rows touch blendMode anyway.
{
  const W = 400, H = 260;
  const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  const SPAN = { from: { x: 60, y: 70 }, to: { x: 340, y: 190 } };
  const BACKGROUND = "#808080";
  const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));

  async function frame(plugin, props) {
    const s = { ...plugin.defaults, ...SPAN, ...props };
    return readPng(await renderToPng(plugin.emit(s, null, VIEW), VIEW, { width: W, height: H, background: BACKGROUND }));
  }

  // Calibrated against this family's own measured pairwise minimum: MEASURED
  // narrowest pair across (DEFAULT) + both 11-row rosters is "Straight" <->
  // "Soft Chevron" at meanAbs 60.05 (maxAbs 128) — a brace's curl/shoulder
  // square moves the WHOLE drawn path, not a sparse texture, so every pair
  // separates by tens of levels. 10 sits an order of magnitude under that
  // measured floor, matching the headroom rect_presets_test.js and
  // arrow_presets_test.js both use relative to their own measured minima.
  const MIN_SEPARATION = 10;

  for (const plugin of bracePlugins) {
    await test(`${plugin.type}: presets.length >= 10`, () => {
      assert.ok(plugin.presets.length >= 10, `${plugin.type} has ${plugin.presets.length} presets`);
    });

    let frames;
    await test(`${plugin.type}: renders (DEFAULT) + every preset`, async () => {
      frames = [{ name: "(DEFAULT)", png: await frame(plugin, {}) }];
      for (const preset of plugin.presets) frames.push({ name: preset.name, png: await frame(plugin, preset.props) });
      assert.equal(frames.length, plugin.presets.length + 1);
    });

    await test(`${plugin.type}: no two of (DEFAULT) + presets render the same picture (C-16)`, () => {
      let narrowest = null;
      for (let i = 0; i < frames.length; i++)
        for (let j = i + 1; j < frames.length; j++) {
          const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
          if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
          assert.ok(d.meanAbs >= MIN_SEPARATION,
            `${plugin.type}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION})`);
        }
      console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs}`);
    });

    await test(`${plugin.type}: every preset writes the IDENTICAL key set`, () => {
      const sets = new Set(plugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
      assert.equal(sets.size, 1, `${plugin.type} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
    });

    await test(`${plugin.type}: every preset's curl/shoulder are within their Inspector row's [0,1] bounds`, () => {
      for (const preset of plugin.presets)
        for (const key of ["curl", "shoulder"])
          assert.ok(preset.props[key] >= 0 && preset.props[key] <= 1,
            `${plugin.type} "${preset.name}": ${key} is ${preset.props[key]}, outside [0, 1]`);
    });
  }
}

// ── §2 IRIS_BLADES ────────────────────────────────────────────────────────────
// A filled bbox widget (the blade assembly). Mid-grey backdrop for the same
// reason as brace: several rows are near-black or near-white fills and a
// backdrop favouring either end would be unfair to the others.
{
  const W = 260, H = 260;
  const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  const BOX = { x: 20, y: 20, w: 220, h: 220 };
  const BACKGROUND = "#808080";
  const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));

  async function frame(props) {
    const s = { ...irisBladesPlugin.defaults, ...BOX, ...props };
    return readPng(await renderToPng(irisBladesPlugin.emit(s, null, VIEW), VIEW, { width: W, height: H, background: BACKGROUND }));
  }

  await test("iris_blades: presets.length >= 10", () => {
    assert.ok(irisBladesPlugin.presets.length >= 10, `iris_blades has ${irisBladesPlugin.presets.length} presets`);
  });

  const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
  for (const preset of irisBladesPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

  // MEASURED: the closest pair across (DEFAULT) + all 10 presets on this rig is
  // (DEFAULT) [blades:8, stopDown:0.5, curvature:0.35] vs "Circular-Aperture
  // Assembly" [blades:10, stopDown:0.5, curvature:1] at meanAbs 10.19 (maxAbs
  // 141) — a real, visibly different assembly (the plates' edges are straight
  // arcs vs a perfect circle) that happens to share the widest stopDown and a
  // similar silhouette at this box size. 8 sits under that measured minimum
  // with headroom, the same shape rect_presets_test.js's MIN_SEPARATION uses
  // relative to its own measured floor.
  const MIN_SEPARATION = 8;

  await test("iris_blades: no two of (DEFAULT) + presets render the same picture (C-16)", () => {
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `iris_blades: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION})`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs}`);
  });

  await test("iris_blades: every preset writes the SAME five geometry knobs", () => {
    const expected = ["bladeReach", "bladeRotation", "blades", "curvature", "stopDown"];
    for (const preset of irisBladesPlugin.presets)
      assert.deepEqual(Object.keys(preset.props).sort(), expected, `iris_blades "${preset.name}": unexpected key set`);
  });
}

// ── §3 FILMSTRIP ──────────────────────────────────────────────────────────────
// See this file's header for why this family is measured in drawn GEOMETRY
// (perforation dimensions + band thickness + colour) rather than pixels: a
// whole-lit-set pixel mean under-detects pairs that differ only in
// perforation pulldown at the same base colour (measured minimum 1.62 among
// this batch's real rows, against a >= 9.4 separation for colour-differing
// pairs — no single pixel floor honestly serves both).
{
  const BOX = { w: 480, h: 90, vertical: false };
  const N_FRAMES = 6;

  await test("filmstrip: presets.length >= 10", () => {
    assert.ok(filmstripPlugin.presets.length >= 10, `filmstrip has ${filmstripPlugin.presets.length} presets`);
  });

  /** Near-pure function (reads filmstripGeom, a pure function of its args; this
   *  wrapper carries no state of its own). The drawn geometry a preset's props
   *  produce, reduced to the dimensions a viewer could actually see: hole
   *  along/across/radius/pitch, band thickness, base colour, and perforated
   *  sides count.
   *  @param {object} props - a preset's props (or {} for the untouched default)
   *  @returns {{color: string, perf: object, band: number}} */
  function drawnGeometry(props) {
    const s = { ...filmstripPlugin.defaults, ...BOX, ...props };
    const g = filmstripGeom(s, N_FRAMES);
    return { color: s.filmColor, perf: g.perf, band: g.bandA.h };
  }

  const rows = [{ name: "(DEFAULT)", g: drawnGeometry({}) }];
  for (const preset of filmstripPlugin.presets) rows.push({ name: preset.name, g: drawnGeometry(preset.props) });

  // A quarter of a canvas unit is the smallest geometry difference that can
  // survive to a distinguishable pixel at 1:1 with antialiasing — the same
  // bound tests/filmstrip_test.js's own look-alike gate uses, restated here so
  // this file needs no import of a test-local constant from another suite.
  const VISIBLE_UNITS = 0.25;
  const DECISIVE = Infinity; // perforated-sides count differs: not a length, always decisive

  await test("filmstrip: no two of (DEFAULT) + presets draw the same holes at the same spacing (C-16)", () => {
    let narrowest = null;
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i].g, b = rows[j].g;
        const geometryDiff = Math.max(
          Math.abs(a.perf.along - b.perf.along), Math.abs(a.perf.across - b.perf.across),
          Math.abs(a.perf.radius - b.perf.radius), Math.abs(a.perf.pitch - b.perf.pitch),
          Math.abs(a.band - b.band), a.perf.sides === b.perf.sides ? 0 : DECISIVE,
        );
        const distinct = geometryDiff >= VISIBLE_UNITS || a.color !== b.color;
        if (!narrowest || (Number.isFinite(geometryDiff) && geometryDiff < narrowest.diff))
          narrowest = { a: rows[i].name, b: rows[j].name, diff: geometryDiff, sameColor: a.color === b.color };
        assert.ok(distinct, `filmstrip: "${rows[i].name}" and "${rows[j].name}" render the same strip (geometry diff ${geometryDiff.toFixed(3)}, same colour ${a.color})`);
      }
    console.log(`      narrowest (excluding colour-only pairs): ${narrowest.a} <-> ${narrowest.b}  geometryDiff=${narrowest.diff.toFixed(3)} sameColor=${narrowest.sameColor}`);
  });

  await test("filmstrip: every preset writes the IDENTICAL key set (filmColor + perfFamily)", () => {
    const sets = new Set(filmstripPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `filmstrip presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });
}

console.log(`\n${passed} preset top-up (batch B) tests passed`);
