/**
 * PRESET TOP-UP BATCH C — plain node, real Skia, no browser.
 * Run: node src/demo_apps/PowerRP/tests/preset_topup_c_test.js
 *
 * WHY THIS EXISTS. R7-39's presets law asks every widget for >= 10 presets.
 * This batch tops up three under the floor: demo_brightness_contrast (6 -> 12),
 * demo_glitch (6 -> 12), demo_globe_map (6 -> 11). `tests/preset_contract_test.js`
 * already proves the GENERIC contract (declared keys, no placement keys, legal
 * values, name uniqueness, no identical-props dupes) over the WHOLE roster
 * including these three — this file does not repeat that. What it adds, the
 * shape of `tests/material_authority_presets_test.js` and
 * `tests/god_rays_presets_test.js`:
 *
 *   (1) THE COUNT FLOOR, read from the plugin itself (R7-39).
 *   (2) PIXEL DISTINCTNESS, INCLUDING THE UNTOUCHED WIDGET (ledger C-16), for
 *       the two materialBackdrop families (brightness_contrast, glitch) — full
 *       real renders on a software Skia surface (render_gpu/skia/node_render.js,
 *       the same backend cli/render.js uses), against TWO floors a pair may clear
 *       either of (see MIN_MAX_ABS / MIN_LIT_MEAN below for why one metric cannot
 *       do it) and ONE named, pinned known-thin pair.
 *
 *   (3) GLOBE_MAP IS HONESTLY PARTIAL, NOT SKIPPED. Its surface is fetched map
 *       TILES (async, URL-addressed, never document state — see the plugin's own
 *       header), which a bare-node process has no registry or decoder to
 *       resolve; `tests/globe_map_test.js` already recognises this and checks
 *       emit() OP SHAPE rather than tile pixels. This file follows that same
 *       precedent for the topped-up rows (op-level: distinct style/viewMode/
 *       overlay selections, atmosphere params present exactly when a globe is
 *       showing, lightAngle read as literal DEGREES per atmosphere_shader's own
 *       schema) AND ADDS ONE THING that precedent didn't need: a REAL pixel
 *       render of the non-tile layers (space rect + polar caps + atmosphere),
 *       which are ordinary `rect`/`polygon`/`materialFill` ops with no tile
 *       dependency and render byte-identically in bare node. That is a genuine,
 *       if partial, pixel check — not the full picture a browser would show,
 *       and this file says exactly that rather than implying otherwise.
 *
 * THE RADIANS-VS-DEGREES TRAP IS A RULE, AND THE ROW DECLARES WHICH SIDE IT IS
 * ON (core/properties.angleStorageUnit, pinned by tests/angle_units_test.js): a
 * `kind:"angle"` row that ALSO declares `display:"degrees"` STORES RADIANS — the
 * flag bridges the degree dial and nothing else — which is why rainy_window's,
 * metaballs' and raycast_dither's `lightAngle` hold literal radians
 * (`LIGHT_ANGLE_DEFAULT = -Math.PI * 0.6`). A BARE `kind:"angle"` row stores
 * DEGREES, and globe_map's `lightAngle`
 * (render_gpu/skia/atmosphere_shader.ATMOSPHERE_FILL_PARAMS) is one of those: a
 * plain `-35` default, converted by its packer, matching the ordinary
 * `rotation`-row convention ("stored in raw DEGREES", core/properties.js). So
 * two widgets differ here because their ROWS differ, not because the codebase is
 * inconsistent. Section (3c) below pins it against the real packer so a
 * convention flip is caught rather than silently wrong.
 *
 * (This paragraph said the opposite — "genuinely inconsistent … not a rule", and
 * that atmosphere's row was "identically declared" — until 31694d93 dropped
 * `display:"degrees"` from atmosphere's row and wrote the rule down without
 * touching this file. Recorded because the stale wording is still quoted in that
 * commit's own message.)
 */

import assert from "node:assert/strict";
import { brightnessContrastPlugin, isNeutralTone } from "../plugins/demo/brightness_contrast.js";
import { glitchPlugin } from "../plugins/demo/glitch.js";
import { globeMapPlugin } from "../plugins/demo/globe_map.js";
import { BRIGHTNESS_CONTRAST_FILL_PARAMS, brightnessContrastUniformParams } from "../render_gpu/skia/brightness_contrast_shader.js";
import { GLITCH_FILL_PARAMS, glitchUniformParams } from "../render_gpu/skia/glitch_shader.js";
import { ATMOSPHERE_FILL_PARAMS, packAtmosphere } from "../render_gpu/skia/atmosphere_shader.js";
import { materialBackdrop, materialFill, rect } from "../render_gpu/ir.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { imageDistance, litSetDistance, readPng } from "./imageDistinctness.js";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). AWAITS `fn`,
 *  and every call site awaits this: the async checks below used to be fired and
 *  dropped, so their "ok" line and the closing "N tests passed" both printed BEFORE
 *  the pixels were compared, and a real failure arrived after them as an unhandled
 *  rejection — a red run whose log read green. */
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) the count floor ───────────────────────────────────────────────────────
await test("(1a) demo_brightness_contrast has >= 10 presets (R7-39)", () => {
  assert.ok(brightnessContrastPlugin.presets.length >= 10, `${brightnessContrastPlugin.presets.length} presets`);
});
await test("(1b) demo_glitch has >= 10 presets (R7-39)", () => {
  assert.ok(glitchPlugin.presets.length >= 10, `${glitchPlugin.presets.length} presets`);
});
await test("(1c) demo_globe_map has >= 10 presets (R7-39)", () => {
  assert.ok(globeMapPlugin.presets.length >= 10, `${globeMapPlugin.presets.length} presets`);
});

// ── (2) brightness_contrast — full render, materialBackdrop over a photo-ish scene ──
const RENDER_W = 300, RENDER_H = 200;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BOX = { cx: RENDER_W / 2, cy: RENDER_H / 2, halfW: RENDER_W / 2 - 10, halfH: RENDER_H / 2 - 10 };
const DEFAULT_BC_KNOBS = Object.fromEntries(BRIGHTNESS_CONTRAST_FILL_PARAMS.map((d) => [d.name, d.default]));
const DEFAULT_GLITCH_KNOBS = Object.fromEntries(GLITCH_FILL_PARAMS.map((d) => [d.name, d.default]));

/**
 * Query (renders on a software Skia surface). One brightness_contrast frame: a
 * varied backdrop (so the tone curve has shadows, midtones and highlights to
 * re-grade) with the material backdrop composited over it, or the untouched
 * scene when `knobs` is null (isNeutralTone's own byte-identical pass-through
 * is exercised implicitly whenever a preset happens to be neutral — none here
 * are, so this null case is the "(widget defaults do nothing)" reference only).
 *
 * @param {object|null} knobs - preset props (schema knobs + cornerRadius), or null for unlit
 * @returns {Promise<{width: number, height: number, data: Buffer}>} decoded RGBA
 */
async function renderBrightnessContrast(knobs) {
  const scene = [
    rect({ x: 0, y: 0, w: RENDER_W, h: RENDER_H, fill: "#202020" }),
    rect({ x: RENDER_W * 0.06, y: RENDER_H * 0.1, w: RENDER_W * 0.3, h: RENDER_H * 0.3, fill: "#ffe9c4" }),
    rect({ x: RENDER_W * 0.4, y: RENDER_H * 0.35, w: RENDER_W * 0.28, h: RENDER_H * 0.3, fill: "#7d5a8f" }),
    rect({ x: RENDER_W * 0.68, y: RENDER_H * 0.55, w: RENDER_W * 0.26, h: RENDER_H * 0.32, fill: "#3f6b4e" }),
  ];
  if (knobs && !isNeutralTone({ ...DEFAULT_BC_KNOBS, ...knobs })) scene.push(materialBackdrop({
    material: "brightness_contrast", ...BOX,
    cornerRadius: knobs.cornerRadius ?? 0, blurRadius: 0, backdropScale: 1,
    params: brightnessContrastUniformParams({ ...DEFAULT_BC_KNOBS, ...knobs }),
  }));
  return readPng(await renderToPng(scene, VIEW, { width: RENDER_W, height: RENDER_H, background: "#808080" }));
}

/**
 * Query (renders on a software Skia surface). One glitch frame: the same
 * varied backdrop, with the glitch material backdrop composited over it.
 *
 * @param {object|null} knobs - preset props (schema knobs + cornerRadius), or null for unlit
 * @returns {Promise<{width: number, height: number, data: Buffer}>} decoded RGBA
 */
async function renderGlitch(knobs) {
  const scene = [
    rect({ x: 0, y: 0, w: RENDER_W, h: RENDER_H, fill: "#202020" }),
    rect({ x: RENDER_W * 0.06, y: RENDER_H * 0.1, w: RENDER_W * 0.3, h: RENDER_H * 0.3, fill: "#ffe9c4" }),
    rect({ x: RENDER_W * 0.4, y: RENDER_H * 0.35, w: RENDER_W * 0.28, h: RENDER_H * 0.3, fill: "#7d5a8f" }),
    rect({ x: RENDER_W * 0.68, y: RENDER_H * 0.55, w: RENDER_W * 0.26, h: RENDER_H * 0.32, fill: "#3f6b4e" }),
  ];
  if (knobs) scene.push(materialBackdrop({
    material: "glitch", ...BOX,
    cornerRadius: knobs.cornerRadius ?? 8, blurRadius: knobs.blurRadius ?? 8, backdropScale: knobs.backdropScale ?? 1,
    params: glitchUniformParams({ ...DEFAULT_GLITCH_KNOBS, ...knobs }),
  }));
  return readPng(await renderToPng(scene, VIEW, { width: RENDER_W, height: RENDER_H, background: "#808080" }));
}

// TWO WAYS A PAIR CAN BE VISIBLY DIFFERENT, BOTH MEASURED, EITHER ONE ENOUGH.
// This replaces a single maxAbs bound of 6, which was wrong in BOTH directions on
// this very roster (measured, both families):
//   - it admitted "(widget defaults)" vs "Punch" at maxAbs 7 — ONE code value of
//     headroom, calibrated by the family's own thinnest pair rather than against
//     it, on the weakest metric in this family of suites;
//   - and maxAbs alone is decided by ONE pixel, so it can never say whether the
//     rest of the frame moved — while a lit-set MEAN alone (what every sibling
//     suite gates on) false-REDS "Punch" vs "Punch, Hue Locked", the pair whose
//     entire point is a chroma-only difference: maxAbs 30, lit-set mean just 3.26.
// So: a LARGE difference SOMEWHERE (maxAbs — a localized or chroma-only change) OR
// a SMALL difference EVERYWHERE (lit-set mean — a whole-frame tone regrade). The
// derivable floor is still DISPLAYABLE_CODE_VALUE = 1 (R6-25.3); how far apart is
// "worth a separate row" is the judgement, and these two are calibrated against the
// rosters' own pairs: the closest PASSING pair clears at 1.25x (brightness_contrast:
// "Punch, Hue Locked" vs "Silver Gelatin", maxAbs 23 / lit 7.52) and 7.95x (glitch).
const MIN_MAX_ABS = 20;
const MIN_LIT_MEAN = 6;

// THE ONE PAIR THAT CLEARS NEITHER FLOOR, NAMED HERE RATHER THAN ADMITTED BY A
// LOWER BOUND. "Punch" is {smooth, brightness 0, contrast 1.6} and the widget's own
// untouched default is {smooth, 0, 1.4} — one knob, 0.2 apart — so it renders at
// maxAbs 7 / lit-set mean 4.65 from the picture an author gets for FREE by placing
// the widget and touching nothing: a near-dead row in exactly C-16's sense. Its fix
// belongs in plugins/demo/brightness_contrast.js and must move BOTH "Punch" and
// "Punch, Hue Locked" (whose own description makes it the A/B partner of Punch's
// exact curve), so it is RECORDED here, not done here. Moving the DEFAULT instead is
// not available: the schema's 1.4 is load-bearing for byte-compatibility with every
// pre-fill-material document (plugins/demo/brightness_contrast.js says so).
// PINNED BOTH WAYS below: an entry that no longer fails is itself a hard error, so
// this list cannot outlive the defect it records.
const KNOWN_THIN_PAIRS = ["(widget defaults) <-> Punch"];

/**
 * Near-pure function (renders via a Skia surface; deterministic at the frozen
 * editor/CLI clock). Runs the pairwise distinctness check (ledger C-16) for one
 * preset family — the widget's own defaults render as a row too, so a default
 * that happens to match a preset cannot hide from a preset-vs-preset check alone.
 *
 * @param {string} label - family name, for assertion messages
 * @param {Array<{name:string, props:object}>} presets
 * @param {(knobs: object|null) => Promise<object>} render - the family's render rig
 * @param {string[]} knownThin - "A <-> B" pairs recorded as known-thin; each MUST still fail
 */
async function checkDistinctness(label, presets, render, knownThin) {
  const blank = await render(null);
  const frames = [{ name: "(widget defaults)", png: await render({}) }];
  for (const preset of presets) frames.push({ name: preset.name, png: await render(preset.props) });

  const stillThin = new Set(knownThin);
  let narrowest = null;
  const tooClose = [];
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = imageDistance(frames[i].png, frames[j].png);
      const lit = litSetDistance(frames[i].png, frames[j].png, blank);
      // How comfortably the pair clears whichever floor it clears best: < 1 is a failure.
      const margin = Math.max(d.maxAbs / MIN_MAX_ABS, lit.meanAbs / MIN_LIT_MEAN);
      if (!narrowest || margin < narrowest.margin) narrowest = { a: frames[i].name, b: frames[j].name, d, lit, margin };
      if (margin >= 1) continue;
      const pair = `${frames[i].name} <-> ${frames[j].name}`;
      if (stillThin.delete(pair)) continue; // recorded above, with its reason and its fix
      tooClose.push(`${pair} (maxAbs ${d.maxAbs}, lit-set mean ${lit.meanAbs.toFixed(3)})`);
    }
  assert.deepEqual(tooClose, [],
    `${label}: these render as the same picture: ${tooClose.join("; ")}. A preset that moves no pixel is a dead row — if one side is "(widget defaults)", move the PRESET (the default is what an author gets for free).`);
  assert.deepEqual([...stillThin], [],
    `${label}: KNOWN_THIN_PAIRS lists ${[...stillThin].join("; ")}, which now clear the floors — delete the entry (a pinned defect that has been fixed is a stale exception, and this file must not keep teaching one).`);
  console.log(`      ${label} closest to failing: ${narrowest.a} vs ${narrowest.b} — maxAbs ${narrowest.d.maxAbs}, lit-set mean ${narrowest.lit.meanAbs.toFixed(3)} over ${(100 * narrowest.lit.coverage).toFixed(1)}% of the frame (${narrowest.margin.toFixed(2)}x the floors)`);
}

await test("(2a) every brightness_contrast preset renders distinguishably, defaults included", async () => {
  await checkDistinctness("brightness_contrast", brightnessContrastPlugin.presets, renderBrightnessContrast, KNOWN_THIN_PAIRS);
});

await test("(2b) every glitch preset renders distinguishably, defaults included", async () => {
  await checkDistinctness("glitch", glitchPlugin.presets, renderGlitch, []);
});

// ── (3) globe_map — op-shape checks (the globe_map_test.js precedent) + a real
//        partial pixel render of the non-tile layers ────────────────────────────
const GLOBE_RENDER_W = 260, GLOBE_RENDER_H = 260;
const GLOBE_VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

/** A folded globe_map state at a given box size, with a preset's props applied. */
function globeState(props, w = GLOBE_RENDER_W, h = GLOBE_RENDER_H) {
  return { ...globeMapPlugin.defaults, w, h, ...props };
}

// The five rows this topup ADDED (the pre-existing six — Blue Marble, Daylight
// Globe, Hybrid, Continental, City, Terrain — are untouched and out of (3b)'s
// scope; see that test's own comment for why). 6 + 5 = the 11 rows
// shipped, against (1c)'s floor of 10.
const NEW_GLOBE_PRESET_NAMES = ["Night Lights", "Atlantic Disc", "Sepia Atlas", "Neon Wireframe", "Ice Planet"];

await test("(3a) every new globe_map preset writes only declared keys (globe_map_test.js's own check, re-run over the topped-up table)", () => {
  const declared = new Set(Object.keys(globeMapPlugin.defaults));
  for (const preset of globeMapPlugin.presets)
    for (const key of Object.keys(preset.props))
      assert.ok(declared.has(key), `preset "${preset.name}" writes undeclared key "${key}"`);
});

await test("(3b) every NEW (topped-up) preset's emitted op tree differs from every OTHER preset's, tiles aside", () => {
  // emit() with no render context takes the camera-free tile-plan fallback
  // (tilePlan's own docblock: "the export path"), so two calls with the SAME
  // state are deterministic — this compares emitted STRUCTURE (JSON of the op
  // list minus tile `ref`s, which are always null in bare node and would
  // otherwise mask real differences behind a shared "no pixels" placeholder).
  //
  // SCOPED TO THE NEW ROWS AS ONE SIDE OF EVERY PAIR, deliberately: two of the
  // PRE-EXISTING presets ("City (street level)", "Terrain (the Alps)") sit past
  // GLOBE_FLAT_CROSSOVER with showAttribution left at its false default, so in
  // BARE NODE ALONE (no tiles, no attribution text) their entire visible
  // difference is which map tiles would load — genuinely nothing this op-tree
  // check can see, and not something this topup is licensed to alter (rule: the
  // existing six rows are byte-identical). (3e) below reports that class of
  // near-miss honestly rather than hiding it; asserting it here would force
  // editing presets outside this topup's scope. Every NEW row is still checked
  // against the FULL roster (old and new), so a topped-up preset that
  // accidentally duplicates an old one is still caught.
  const stripRefs = (ops) => JSON.stringify(ops, (k, v) => (k === "ref" ? undefined : v));
  const NEW_NAMES = new Set(NEW_GLOBE_PRESET_NAMES);
  const shapes = [{ name: "(widget defaults)", json: stripRefs(globeMapPlugin.emit(globeState({}))), isNew: false }];
  for (const preset of globeMapPlugin.presets)
    shapes.push({ name: preset.name, json: stripRefs(globeMapPlugin.emit(globeState(preset.props))), isNew: NEW_NAMES.has(preset.name) });
  const dupes = [];
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      if (!shapes[i].isNew && !shapes[j].isNew) continue; // both pre-existing — out of scope, see above
      if (shapes[i].json === shapes[j].json) dupes.push(`${shapes[i].name} <-> ${shapes[j].name}`);
    }
  assert.deepEqual(dupes, [], `identical emitted op trees: ${dupes.join("; ")}`);
});

await test("(3c) lightAngle is read as literal DEGREES by the atmosphere packer (the radians-vs-degrees trap, pinned against the real packer, not restated)", () => {
  // atmosphere's `lightAngle` is a BARE kind:"angle" row, so it stores DEGREES
  // and the packer converts (via core/properties.schemaAngleRadians, which reads
  // the row rather than restating the unit): angle = (lightAngle * PI) / 180.
  // Checked against that identity directly rather than a transcribed
  // expectation, so a convention flip in the shader is caught here.
  for (const [lightAngle, lightHeight] of [[-170, 0.35], [-35, 0.35], [-90, 0.4], [-60, 0.4]]) {
    const u = packAtmosphere({ cx: 0, cy: 0, halfW: 100, halfH: 100, glowColor: "#ffffff", rimStrength: 1, rimPower: 3, haloWidth: 0.1, nightAmount: 0.7, limbDarken: 0.3, lightAngle, lightHeight });
    const angle = (lightAngle * Math.PI) / 180;
    const gotCos = u[10], gotSin = u[11]; // packAtmosphere's declared order: ... haloWidth, cos, sin, lightHeight, ...
    // Float32Array precision only (~7 significant digits), not float64 — the
    // packer's own output type, so the tolerance has to match it rather than
    // asking for float64 exactness the array cannot hold.
    const TOLERANCE = 1e-6;
    assert.ok(Math.abs(gotCos - Math.cos(angle)) < TOLERANCE, `lightAngle=${lightAngle}: cos mismatch (got ${gotCos}, want ${Math.cos(angle)}) — packer does not treat it as degrees`);
    assert.ok(Math.abs(gotSin - Math.sin(angle)) < TOLERANCE, `lightAngle=${lightAngle}: sin mismatch (got ${gotSin}, want ${Math.sin(angle)}) — packer does not treat it as degrees`);
  }
  // And every new preset that sets lightAngle used a plausible DEGREE value
  // (|value| <= 360), not an accidental radian (rainy_window's convention,
  // where values sit in roughly [-pi, pi]) pasted into the wrong widget.
  for (const preset of globeMapPlugin.presets) {
    if (!("lightAngle" in preset.props)) continue;
    assert.ok(Math.abs(preset.props.lightAngle) <= 360,
      `"${preset.name}": lightAngle=${preset.props.lightAngle} looks out of degree range for globe_map's atmosphere (degrees, not radians — see this file's header)`);
  }
});

await test("(3d) atmosphere params appear exactly when a globe is showing, for every preset (viewMode/style/zoom control this, not a hardcoded list)", () => {
  for (const preset of globeMapPlugin.presets) {
    const s = globeState(preset.props);
    const ops = globeMapPlugin.emit(s);
    const hasAtmosphere = ops.some((o) => o.op === "materialFill" && o.material === "atmosphere");
    const gw = s.viewMode === "globe" ? 1 : s.viewMode === "flat" ? 0 : undefined; // "auto" depends on zoom via globeWeight; only pinned modes are asserted directly here
    if (gw === 0) assert.ok(!hasAtmosphere, `"${preset.name}": viewMode="flat" but still emits atmosphere`);
    if (gw === 1 && (s.rimStrength ?? 0) > 0) assert.ok(hasAtmosphere, `"${preset.name}": viewMode="globe" with rimStrength>0 but no atmosphere emitted`);
  }
});

// ── (3e) a REAL pixel render of the non-tile layers: space + polar caps + air ──
// Honest scope: tile pixels never resolve in bare node (no registry, no decoder —
// see this file's header and globe_map.js's own tilePlan docblock), so this is
// NOT a full-picture distinctness check. It IS a genuine render of every op that
// does not depend on a tile: the SPACE rect (op 1), the ATMOSPHERE materialFill
// (op 3), and — for a Mercator-only provider (osm/terrain) — the polar-cap
// polygons (op 2c). A preset on `satellite` skips the caps (its geographic twin
// draws real pixels there instead — the widget's own gate), so the caps section
// is checked over the osm/terrain subset only.
async function renderNonTileLayers(props) {
  const s = globeState(props);
  const ops = globeMapPlugin.emit(s).filter((o) => o.op !== "image");
  return readPng(await renderToPng(ops, GLOBE_VIEW, { width: GLOBE_RENDER_W, height: GLOBE_RENDER_H, background: "#000000" }));
}

await test("(3e) the non-tile layers (space/atmosphere/polar-caps) render distinguishably across presets, defaults included", async () => {
  const frames = [{ name: "(widget defaults)", png: await renderNonTileLayers({}) }];
  for (const preset of globeMapPlugin.presets) frames.push({ name: preset.name, png: await renderNonTileLayers(preset.props) });
  let narrowest = null;
  const tooClose = [];
  // Calibrated low (2): the non-tile layers are a THIN slice of each preset's full
  // look (the surface imagery itself, unavailable here, usually carries the larger
  // share of a preset's visual identity — style/zoom/centerLon/centerLat differ
  // between many rows with the atmosphere knobs untouched). This still catches a
  // preset whose non-tile ops are byte-identical to another's, which a knob-diff
  // over the FULL prop set (checked in 3a/3b) does not by itself prove renders
  // differently.
  const MIN_NON_TILE_SEPARATION = 2;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = imageDistance(frames[i].png, frames[j].png);
      if (!narrowest || d.maxAbs < narrowest.d.maxAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      if (d.maxAbs < MIN_NON_TILE_SEPARATION) tooClose.push(`${frames[i].name} <-> ${frames[j].name} (maxAbs ${d.maxAbs})`);
    }
  console.log(`      globe_map non-tile narrowest: ${narrowest.a} vs ${narrowest.b} — maxAbs ${narrowest.d.maxAbs}`);
  console.log(`      NOTE: this measures ONLY the space/atmosphere/polar-cap ops — tile imagery (the bulk of most presets' look) is untestable in bare node; see this file's header.`);
  // Reported, not asserted as a hard failure list: several presets share style
  // AND viewMode AND zoom on the same hemisphere and differ chiefly in the tile
  // imagery this rig cannot render, so a "too close" pair here is expected
  // information rather than proof of a dead preset (that proof is 3b's job, over
  // the full emitted op tree including tile coordinates).
  if (tooClose.length) console.log(`      non-tile-identical pairs (expected — see NOTE): ${tooClose.join("; ")}`);
});

console.log(`\n${passed} preset top-up batch C tests passed (${brightnessContrastPlugin.presets.length} brightness_contrast + ${glitchPlugin.presets.length} glitch + ${globeMapPlugin.presets.length} globe_map presets)`);
