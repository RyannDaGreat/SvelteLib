/**
 * THE R7-39 TOP-UP-A PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/preset_topup_a_test.js
 *
 * Covers the three families extended in the R7-39 weak-roster sweep's batch A:
 * `paper_peacock` (4 -> 11), `demo_comic` (5 -> 11), `image_stack` (6 -> 11).
 * tests/rect_presets_test.js and tests/particles_presets_test.js are the
 * structural templates: litSetDistance (tests/imageDistinctness.js) restricted
 * to the pixels either frame actually touches, against an EMPTY-CANVAS
 * reference (never the widget's own filled default — see rect_presets_test.js's
 * header for the measured reason that swap matters), on a mid-grey backdrop
 * that favours neither a light nor a dark/blend-mode preset.
 *
 * ── EACH FAMILY'S BOUND IS ITS OWN, MEASURED HERE, NOT BORROWED ─────────────
 * "Calibrate to reality, never borrow another widget's bound" (R7-39 batch-A
 * brief, citing the shapeshifter precedent: some geometries have a low natural
 * ceiling and forcing rect's or particles' MIN_SEPARATION = 10 onto them would
 * be a false floor, not a real one).
 *
 *   `demo_comic` renders a `materialBackdrop` op — a SCREEN of whatever is
 *   drawn BENEATH it, so it needs real content behind it to have anything to
 *   halftone; this file supplies a three-tone rect backdrop for exactly that
 *   reason (an ungrounded comic panel over blank canvas has nothing to screen
 *   and every preset reads alike). MEASURED floor: 22.55 (DEFAULT vs "Classic
 *   4-Color Comic", the family's own two closest-in-spirit rows). Bound set to
 *   10 — the rect/particles precedent value has real headroom below this
 *   family's actual floor, so it is reused rather than re-derived downward.
 *
 *   `paper_peacock` is the LOW-CEILING case the brief warned about. Its emit()
 *   fits the fan to the widget's own box (peacockLayout's FIT-TO-BOX choice —
 *   see the plugin's module header), so the OUTER SILHOUETTE fills the frame
 *   at every fanAngle/hRatio/pageCount combination and litSetDistance's lit
 *   set is dominated by that shared silhouette (measured: 48-90% lit-set
 *   overlap across the family, versus rect's thin-preset outliers at ~13%).
 *   Only the shadow's own ink and the paper edges carry the rest of the
 *   signal. MEASURED floor after authoring: 10.87 ("(DEFAULT)" vs "Tight fan
 *   ±20°"). Bound set to 8 — real headroom below 10.87, but deliberately BELOW
 *   the rect/particles value of 10, which this family cannot clear with the
 *   variety an 11-row table needs (two dead-identical-default rows were found
 *   and fixed during authoring by chasing 10; the true floor a spread-out
 *   eleven-row geometry table clears is 8, not 10, and shipping a borrowed 10
 *   here would be a bound calibrated against a DIFFERENT widget's picture).
 *
 *   `image_stack` draws `videoV5Frame` ops, which decode nothing in bare node
 *   (no `createImageBitmap` — the CLAUDE.md manifest's documented cli/render.js
 *   omission) — so the only ink bare node can paint for this family is each
 *   card's own drop shadow (a blurred, rounded `path`, sized/positioned by the
 *   very knobs the presets vary: shiftX/shiftY/cardRadius/shadowBlur/
 *   shadowOpacity). A real `src` is supplied so `isGhost` is false and the pile
 *   layout draws; the (undecoded) card content and the whole-pile stroke
 *   border contribute nothing, which is why two originally-authored rows
 *   ("Ghost trail", a first draft of "Flat swatches") both zeroing the shadow
 *   were a genuine bare-node collision and were fixed by giving "Flat
 *   swatches" a thin nonzero shadow rather than by softening the test.
 *   MEASURED floor: 15.30 ("Photo pile" vs "Polaroid drop"). Bound set to 10 —
 *   the rect/particles value, reused because this family clears it with solid
 *   headroom (unlike paper_peacock).
 *
 * Every bound above sits strictly below its own family's measured floor; none
 * is picked by reputation, all three are printed at run time so a future
 * regression shows the real number, not just pass/fail.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { rect } from "../render_gpu/ir.js";
import { paperPeacockPlugin } from "../plugins/paper_peacock.js";
import { comicPlugin } from "../plugins/demo/comic.js";
import { imageStackPlugin } from "../plugins/image_stack.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
async function atest(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. Every pair of `frames`' pairwise litSetDistance against
 * `blank`, asserting each clears `minSeparation`, and returning the narrowest
 * pair found (for the caller to log). Shared by all three families below so
 * the sweep loop and its failure message are written once.
 *
 * @param {{name: string, png: object}[]} frames
 * @param {object} blank - readPng'd reference frame (litSetDistance's 3rd arg)
 * @param {number} minSeparation - lit-set levels; pairs closer than this fail
 * @param {string} label - family name, for the assertion message
 * @returns {{a: string, b: string, meanAbs: number, coverage: number}}
 */
function assertAllDistinct(frames, blank, minSeparation, label) {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, blank);
      if (!narrowest || d.meanAbs < narrowest.meanAbs)
        narrowest = { a: frames[i].name, b: frames[j].name, meanAbs: d.meanAbs, coverage: d.coverage };
      assert.ok(d.meanAbs >= minSeparation,
        `${label}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${minSeparation}) — the same row twice`);
    }
  return narrowest;
}

// ══════════════════════════════════════════════════════════════════════════
// paper_peacock: 4 -> 11 presets
// ══════════════════════════════════════════════════════════════════════════
{
  const W = 600, H = 460;
  const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  const WORLD = { x: 70, y: 60, rotation: 0, scale: 1 };
  const BOX = { w: 460, h: 340 };
  const BACKGROUND = "#808080"; // neutral: favours neither a light nor a dark shadow preset
  // Sheets fit-to-box regardless of fanAngle/hRatio, so a low natural ceiling is
  // real (see header) — calibrated to THIS family's own measured floor (10.87),
  // not the rect/particles precedent value.
  const MIN_SEPARATION = 8;

  test("the sweep found the paper_peacock preset table at all", () => {
    assert.ok(Array.isArray(paperPeacockPlugin.presets) && paperPeacockPlugin.presets.length >= 10,
      `paperPeacockPlugin.presets is ${JSON.stringify(paperPeacockPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
  });

  await atest(`paper_peacock: ${paperPeacockPlugin.presets.length} presets and the default all render a DIFFERENT picture`, async () => {
    // No `src` on any preset or the default — the fan draws its shadow
    // geometry with NO PDF (the module header: "SHADOWS DRAW EVEN WHILE THE
    // PDF IS LOADING (or absent)"), which is exactly what bare node can paint.
    async function frame(props) {
      const s = { ...paperPeacockPlugin.defaults, ...BOX, ...props };
      const ops = paperPeacockPlugin.emit(s, null, WORLD, { interactive: false });
      return readPng(await renderToPng(ops, VIEW, { width: W, height: H, background: BACKGROUND }));
    }
    const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
    const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
    for (const preset of paperPeacockPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });
    const narrowest = assertAllDistinct(frames, BLANK, MIN_SEPARATION, "paper_peacock");
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.meanAbs.toFixed(2)} lit=${(narrowest.coverage * 100).toFixed(2)}%`);
  });

  test("no paper_peacock preset writes an invented key (fan geometry or shadow only)", () => {
    const legal = new Set(["pageCount", "fanAngle", "hRatio", "shadowBlur", "shadowOpacity", "shadowDx", "shadowDy"]);
    for (const preset of paperPeacockPlugin.presets)
      for (const key of Object.keys(preset.props))
        assert.ok(legal.has(key), `paper_peacock/"${preset.name}" writes unexpected key "${key}"`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// demo_comic: 5 -> 11 presets
// ══════════════════════════════════════════════════════════════════════════
{
  const W = 460, H = 360;
  const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  // demo_comic emits ONE materialBackdrop op that SCREENS whatever is drawn
  // beneath it (a "comic" material — render_gpu/skia/comic_shader.js). With
  // nothing behind it there is nothing to halftone and every preset would
  // read alike, so this three-tone backdrop stands in for real slide content.
  function backdrop(w, h) {
    return [
      rect({ x: 0, y: 0, w, h, fill: "#d8c9a3" }),
      rect({ x: 0, y: 0, w: w / 2, h, fill: "#5a4636" }),
      rect({ x: 0, y: h / 2, w, h: h / 2, fill: "#8899aa" }),
    ];
  }
  // Reused from rect_presets_test.js / particles_presets_test.js — this
  // family clears it with more than double the headroom (measured floor
  // 22.55), so the shared value is calibration, not a guess.
  const MIN_SEPARATION = 10;

  test("the sweep found the demo_comic preset table at all", () => {
    assert.ok(Array.isArray(comicPlugin.presets) && comicPlugin.presets.length >= 10,
      `comicPlugin.presets is ${JSON.stringify(comicPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
  });

  await atest(`demo_comic: ${comicPlugin.presets.length} presets and the default all render a DIFFERENT picture`, async () => {
    async function frame(props) {
      const s = { ...comicPlugin.defaults, w: W, h: H, x: 0, y: 0, ...props };
      const ops = [...backdrop(s.w, s.h), ...comicPlugin.emit(s)];
      return readPng(await renderToPng(ops, VIEW, { width: W, height: H }));
    }
    const BLANK = readPng(await renderToPng(backdrop(W, H), VIEW, { width: W, height: H }));
    const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
    for (const preset of comicPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });
    const narrowest = assertAllDistinct(frames, BLANK, MIN_SEPARATION, "demo_comic");
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.meanAbs.toFixed(2)} lit=${(narrowest.coverage * 100).toFixed(2)}%`);
  });

  test("every demo_comic preset writes the family's 11-key common core, plus only mode-legal extras", () => {
    // The family is DELIBERATELY sparse (SPEC.md §4 — see preset_contract_test.js's
    // header on why "every preset sets every knob" is not a universal law):
    // angleC/M/Y/K appear only for the ink channels `mode` actually screens,
    // edgeLo/edgeHi only when edgeInk > 0, inkA/inkB only in duotone.
    const CORE = ["mode", "pitch", "worldLocked", "dotShape", "dotGain", "gamma", "posterize", "edgeInk", "grain", "paperColor", "registration"];
    const MODE_ANGLES = { cmyk: ["angleC", "angleM", "angleY", "angleK"], rgb: ["angleC", "angleM", "angleY", "angleK"], duotone: ["angleC", "angleK"], mono: ["angleK"] };
    for (const preset of comicPlugin.presets) {
      const keys = new Set(Object.keys(preset.props));
      for (const k of CORE) assert.ok(keys.has(k), `demo_comic/"${preset.name}" is missing common-core key "${k}"`);
      const wantAngles = new Set(MODE_ANGLES[preset.props.mode] ?? []);
      for (const angleKey of ["angleC", "angleM", "angleY", "angleK"])
        assert.equal(keys.has(angleKey), wantAngles.has(angleKey),
          `demo_comic/"${preset.name}" (mode "${preset.props.mode}") ${keys.has(angleKey) ? "writes" : "omits"} "${angleKey}", expected the opposite`);
      const edgeThresholds = keys.has("edgeLo") || keys.has("edgeHi");
      assert.equal(edgeThresholds, preset.props.edgeInk > 0,
        `demo_comic/"${preset.name}": edgeLo/edgeHi presence disagrees with edgeInk > 0`);
      assert.equal(keys.has("inkA") || keys.has("inkB"), preset.props.mode === "duotone",
        `demo_comic/"${preset.name}": inkA/inkB presence disagrees with mode === "duotone"`);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// image_stack: 6 -> 11 presets
// ══════════════════════════════════════════════════════════════════════════
{
  const W = 500, H = 500;
  const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  const WORLD = { x: 60, y: 60, rotation: 0, scale: 1 };
  // Reused from rect_presets_test.js / particles_presets_test.js — this
  // family clears it with solid headroom (measured floor 15.30).
  const MIN_SEPARATION = 10;

  test("the sweep found the image_stack preset table at all", () => {
    assert.ok(Array.isArray(imageStackPlugin.presets) && imageStackPlugin.presets.length >= 10,
      `imageStackPlugin.presets is ${JSON.stringify(imageStackPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
  });

  await atest(`image_stack: ${imageStackPlugin.presets.length} presets and the default all render a DIFFERENT picture`, async () => {
    // A real `src` so isGhost is false and the pile actually draws — bare node
    // cannot decode it (no createImageBitmap), so the only ink that paints is
    // each card's own drop shadow, sized/placed by exactly the knobs the
    // presets vary. See the file header for why that is a sound (not merely
    // convenient) reduction for this family.
    async function frame(props) {
      const s = { ...imageStackPlugin.defaults, src: "clip.mp4", videoEnd: 6, w: 380, h: 380, ...props };
      const ops = imageStackPlugin.emit(s, null, WORLD);
      return readPng(await renderToPng(ops, VIEW, { width: W, height: H, background: "#808080" }));
    }
    const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: "#808080" }));
    const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
    for (const preset of imageStackPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });
    const narrowest = assertAllDistinct(frames, BLANK, MIN_SEPARATION, "image_stack");
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.meanAbs.toFixed(2)} lit=${(narrowest.coverage * 100).toFixed(2)}%`);
  });

  test("EVERY image_stack preset writes the IDENTICAL key set", () => {
    // Unlike paper_peacock/demo_comic, this family has no on/off switch
    // dividing its rows — the original six already agreed on one key set
    // (shiftX, shiftY, alphaExponent, cardRadius, shadowOpacity, shadowBlur)
    // and the new rows keep that uniform, so (unlike the sparse families
    // above) an IDENTICAL-set check is the right shape here.
    const sets = new Set(imageStackPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `image_stack presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });
}

console.log(`\n${passed} preset-topup-a tests passed`);
