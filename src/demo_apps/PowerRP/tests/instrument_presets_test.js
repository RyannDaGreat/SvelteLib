/**
 * THE INSTRUMENTS-AND-READOUTS PRESET LIBRARIES — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/instrument_presets_test.js
 *
 * Subjects: the widgets that MEASURE or MAGNIFY something — clock_digital,
 * progress_bar, magnifier, demo_magnify, qrcode, clock_analog. ONE rig, six
 * subjects, because six copies of the same rig is the duplicate-mirror defect the
 * convention ledger exists to stop; each subject contributes only the three things
 * that genuinely differ (its scene, its reading, and its excluded-key reasons).
 *
 * WHAT THIS PROVES, and it is deliberately DISJOINT from tests/preset_contract_test.js
 * (which sweeps every plugin for invented keys, names, descriptions, equation form
 * and identical props — none of that is repeated here):
 *
 *   (1) THE OVERLAY RULE, in both directions. app.applyPreset writes `props` as an
 *       OVERLAY, so a knob one row omits keeps whatever the PREVIOUSLY HOVERED row
 *       left there and two rows' rendering becomes hover-order dependent. So every
 *       preset in a whole-look family must set every look knob. "Look knob" is
 *       DERIVED from the plugin's registered inspector minus a per-subject
 *       EXCLUDED map — so a knob added tomorrow joins the demand with no edit here,
 *       and the excluded map is where each family's judgements are written down and
 *       pinned.
 *
 *   (2) NO COMPOSITION KEY. A preset changes the LOOK; it never moves something the
 *       user already placed (plugins/demo/lens_flare.js's lightWorldX/Y rule, and
 *       its flareScale corollary for "how it FITS its box").
 *
 *   (3) DISTINCTNESS IN PIXELS, which is why a bare-node RENDER suite exists at all.
 *       A table whose rows differ is worthless if its renders do not, and no rule
 *       above can see that. Every preset is rendered through the CLI's own software
 *       Skia path and scored pairwise with the SHARED metric
 *       (tests/imageDistinctness.js) rather than a seventh hand-rolled pixel diff.
 *
 *       THE WIDGET'S OWN DEFAULTS ARE IN THE COMPARISON (ledger C-16). A widget
 *       whose untouched state renders identically to a shipped preset has a dead row
 *       that no preset-vs-preset comparison can ever see, because the default is not
 *       a preset. When that happens the DEFAULT moves, not the sourced preset.
 *
 * WHY BARE NODE AND NOT A BROWSER PROBE. Measured before choosing: all six subjects
 * draw on a software surface, backdrop samplers included — the magnifiers' lens
 * re-render path allocates its scratch through CanvasKit.MakeSurface and needs no
 * GL. Bare node is far cheaper and lands in the gate as a `*_test.js`. (Bare-node
 * Skia genuinely cannot draw image/video/PDF/LaTeX/Mermaid/filmstrip; none of these
 * six is one of those.)
 *
 * WHAT IT DOES NOT PROVE: that the Tools pane shows these rows in this order with
 * these tips, or that hover-preview is free. Those are browser facts and live in
 * tests/toolspane_probe.js and tests/lens_flare_presets_probe.js.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDocument } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { closestPair, imageDistance, indistinguishable, readPng } from "./imageDistinctness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/instrument_presets_test");

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

// ── the scene ────────────────────────────────────────────────────────────────
// One camera and one render size for every subject, so a reader comparing two
// families is comparing pictures taken the same way. 480x270 resolves the finest
// thing any subject draws (a 29-module QR code across 400 world units -> ~7 render
// px per module) while keeping a software render of ~70 frames inside a few seconds.
const CAM = { x: 0, y: 0, w: 960, h: 540 };
const RENDER_W = 480, RENDER_H = 270;
// Mid grey: no subject's ink and no subject's track is near it, so nothing
// disappears into the page for the wrong reason.
const BACKGROUND = "#808080";

// State every widget has and no LOOK preset may write — geometry, transform,
// opacity and the two universal effect knobs no subject family models.
const COMPOSITION_KEYS = new Set([
  "type", "x", "y", "cx", "cy", "w", "h", "z", "rotation", "scale", "rotationAnchor",
  "opacity", "softEdges", "blendMode",
]);

/**
 * Pure function. An Inspector row key reduced to the ITEM-STATE key a preset would
 * write. Effect-bundle rows are dotted (`bloom.radius`) while a preset writes the
 * WHOLE bundle object (`bloom`), which is the only place the two vocabularies differ.
 *
 * @param {string} rowKey - an inspector row's `key`
 * @returns {string} the top-level item-state key
 *
 * @example stateKey("bloom.radius") // "bloom"
 * @example stateKey("fillColor") // "fillColor"
 */
function stateKey(rowKey) {
  return rowKey.split(".")[0];
}

/**
 * Pure function. The LOOK keys a whole-look family must set on every preset:
 * every top-level state key the plugin's registered inspector offers, minus the
 * composition keys and minus this subject's own EXCLUDED map. Derived from the live
 * inspector so a knob added tomorrow joins the demand with no edit to this file.
 *
 * @param {object} plugin - a registered plugin
 * @param {object} excluded - key → the reason it is out of the family
 * @returns {string[]} look keys, inspector order, de-duplicated
 *
 * @example // lookKeys(registry.get("qrcode"), {data: "the payload is the author's content"})
 * // ["ecLevel", "dark", "light", "quietModules"]
 */
function lookKeys(plugin, excluded) {
  const seen = [];
  for (const row of plugin.inspector ?? []) {
    if (!row.key) continue;
    const key = stateKey(row.key);
    if (COMPOSITION_KEYS.has(key) || key in excluded || seen.includes(key)) continue;
    if (!(key in (plugin.defaults ?? {}))) continue;
    seen.push(key);
  }
  return seen;
}

/**
 * Query→build. A one-slide document holding THE camera, an optional backdrop, and
 * ONE subject widget at its plugin defaults with `props` overlaid. Slide 0's delta
 * creates everything, which is the document model's own rule.
 *
 * @param {object} subject - a SUBJECTS entry
 * @param {object} props - the preset's props (empty for the defaults baseline)
 * @returns {object} a PowerRP document
 */
function docOf(subject, props) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: BACKGROUND });
  (subject.backdrop ?? []).forEach((spec, i) => { items[`bg${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  items.subject = { ...registry.get(subject.type).defaults, type: subject.type, ...subject.frame, ...subject.reading, ...props };
  return doc;
}

/**
 * Command (renders on a software surface; writes a PNG under .claude_vlm_checks).
 * One frame of a subject, through the SAME path the CLI renderer uses — evaluate,
 * derive, cameraFrameIR, paint_skia — so what is scored is what ships.
 *
 * @param {object} subject - a SUBJECTS entry
 * @param {object} props - the preset's props
 * @param {string} label - PNG basename
 * @returns {Promise<{width: number, height: number, data: Buffer}>} the decoded frame
 */
async function frameOf(subject, props, label) {
  const doc = docOf(subject, props);
  const state = evaluatedStateAt(doc, 0, 1, registry);
  const rect = cameraRect(state, doc.meta);
  const png = await renderToPng(cameraFrameIR(state, doc.meta, registry), fitRectView(rect, RENDER_W, RENDER_H, 1),
    { width: RENDER_W, height: RENDER_H, background: rect.background });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${label}.png`), Buffer.from(png));
  return readPng(png);
}

// ── the subjects ─────────────────────────────────────────────────────────────
// A LENS OVER A FLAT COLOUR IS THE SAME PICTURE AT EVERY POWER, so a magnifier
// family scored over one would come back "all identical" for a reason that has
// nothing to do with the presets. This backdrop carries the three things a lens
// preset acts on: SMALL TYPE under the lens centre (a frequency ramp — at 1.5x a
// 9-unit glyph is 13 units and at 20x it is 180, so every rung of the power ladder
// lands on a visibly different crop), a BRIGHT half and a DARK half so a rim colour
// and the soft-versus-crisp sampling both read, and saturated hues so a chroma-only
// difference is not lost.
const LENS_FRAME = { x: 340, y: 130, w: 280, h: 280 };
const LENS_SPECIMEN_SIZE = 9;
function lensBackdrop() {
  return [
    { type: "rect", x: 0, y: 0, w: CAM.w / 2, h: CAM.h, z: 1, fill: "#f2efe6", strokeWidth: 0 },
    { type: "rect", x: CAM.w / 2, y: 0, w: CAM.w / 2, h: CAM.h, z: 1, fill: "#12141c", strokeWidth: 0 },
    { type: "circle", x: 90, y: 60, w: 150, h: 150, z: 2, fill: "#e5484d", strokeWidth: 0 },
    { type: "circle", x: 690, y: 330, w: 150, h: 150, z: 2, fill: "#30a46c", strokeWidth: 0 },
    {
      type: "plaintext", x: 300, y: 150, w: 360, h: 240, z: 3,
      text: "the quick brown fox jumps over the lazy dog ".repeat(40),
      size: LENS_SPECIMEN_SIZE, fill: "#7b61ff", align: "left", valign: "top",
    },
  ];
}
// An afternoon hour so `hour12` changes the digits (17 -> 5), and a single-digit
// minute so `leadingZero` changes the MM:SS form (04:56 -> 4:56). A reading where
// neither moved would hide two of the digital family's axes from the pixel check.
const SAMPLE_TIME_SECONDS = 17 * 3600 + 4 * 60 + 56;

const SUBJECTS = [
  {
    type: "clock_digital",
    frame: { x: 80, y: 170, w: 800, h: 200, size: 120 },
    reading: { time: SAMPLE_TIME_SECONDS },
    excluded: {
      time: "THE READING, usually bound `= time` — a literal write silently unbinds it (the lightWorldX/Y rule)",
      size: "how the readout FITS the box the author dragged, not what it looks like (the flareScale test)",
      shadow: "no readout researched for this family is defined by a cast shadow",
      innerShadow: "an engraved LCD would want it, but its behaviour on a text op's glyph interiors is unverified",
    },
  },
  {
    type: "qrcode",
    // Square and large: the grid is drawn into min(w, h), so a non-square box would
    // waste the check's resolution on empty margin.
    frame: { x: 280, y: 30, w: 480, h: 480 },
    excluded: {
      data: "THE PAYLOAD — the author's content, the purest case of a preset refusing to overwrite the reading",
      shadow: "an effect changes the local luminance around the modules, which is the one property decoding depends on",
      bloom: "as above — a family carrying a scannability claim leaves the effects bundle alone",
      innerShadow: "as above",
    },
  },
  {
    type: "magnifier",
    frame: LENS_FRAME,
    backdrop: lensBackdrop(),
    excluded: {
      "origin": "THE TARGET the author retargeted the lens to — the same class as a dragged light position",
      "strokeOffset": "a stroke-trim row the registry sweep offers with NO default; whether the magnify paint handler honours a trimmed rim is unverified, so writing one risks a dead property",
      "strokeStart": "as strokeOffset", "strokeEnd": "as strokeOffset", "strokePhase": "as strokeOffset",
      "strokeCapStart": "as strokeOffset", "strokeCapEnd": "as strokeOffset",
      "strokeJoin": "as strokeOffset", "strokeMiter": "as strokeOffset",
      "shadow": "a magnifier is a BACKDROP SAMPLER and what the effect substrate does to an op whose content is the composite-so-far is unverified",
      "bloom": "as shadow", "innerShadow": "as shadow",
    },
  },
  {
    type: "demo_magnify",
    frame: LENS_FRAME,
    backdrop: lensBackdrop(),
    excluded: {
      "origin": "THE TARGET — as on the canonical magnifier",
      "shadow": "a backdrop sampler's effect substrate is unverified — as on the canonical magnifier",
      "bloom": "as shadow", "innerShadow": "as shadow",
    },
  },
];

// Widget pairs whose preset libraries are coordinated BY NAME, because a preset
// applies to one item and the mechanism is deliberately not extended to reach
// siblings. A hand-maintained correspondence across two files is the single
// highest-risk pattern in this codebase, so it gets a gate rather than a comment.
const PAIRED_FAMILIES = [["magnifier", "demo_magnify"]];
// Both magnifier tables carry nine names verbatim. A floor, so the pairing cannot
// silently collapse to nothing while every other check still passes.
const MIN_SHARED_NAMES = 8;

// ── (1) THE OVERLAY RULE ─────────────────────────────────────────────────────
test("(1) every preset sets EVERY look knob of its family", () => {
  for (const subject of SUBJECTS) {
    const plugin = registry.get(subject.type);
    const want = lookKeys(plugin, subject.excluded);
    assert.ok(want.length >= 4, `${subject.type}: only ${want.length} look keys derived — lookKeys is mis-deriving, so the check below would be near-vacuous`);
    for (const preset of plugin.presets) {
      const missing = want.filter((k) => !(k in preset.props));
      assert.deepEqual(missing, [],
        `${subject.type} "${preset.name}" omits ${missing.join(", ")} — an incomplete overlay makes this row's render depend on which row was hovered before it`);
    }
    console.log(`      ${subject.type}: ${plugin.presets.length} presets x ${want.length} look knobs (${want.join(", ")})`);
  }
});

// ── (2) NO COMPOSITION KEY ───────────────────────────────────────────────────
test("(2) no preset writes a composition key or a key its family excluded", () => {
  for (const subject of SUBJECTS) {
    const plugin = registry.get(subject.type);
    for (const preset of plugin.presets) {
      const illegal = Object.keys(preset.props).filter((k) => COMPOSITION_KEYS.has(k) || k in subject.excluded);
      assert.deepEqual(illegal, [],
        `${subject.type} "${preset.name}" writes ${illegal.map((k) => `${k} (${subject.excluded[k] ?? "composition"})`).join("; ")}`);
    }
  }
});

// ── (3) SIBLING PAIRING, DERIVED RATHER THAN LISTED ──────────────────────────
test("(3) a preset name unique to one sibling is one the OTHER's schema cannot express", () => {
  for (const [a, b] of PAIRED_FAMILIES) {
    const of = (type) => new Map((registry.get(type).presets ?? []).map((p) => [p.name, p]));
    const [A, B] = [of(a), of(b)];
    const shared = [...A.keys()].filter((n) => B.has(n));
    assert.ok(shared.length >= MIN_SHARED_NAMES,
      `${a} and ${b} share only ${shared.length} preset names (${shared.join(", ")}) — the by-name pairing has drifted apart`);
    // The derivation: a name is allowed to be unpaired ONLY because the sibling
    // genuinely cannot say it. Asked of the LIVE schemas rather than restated as a
    // list that would rot beside them.
    //
    // AND THE VALUE MUST BE DOING WORK. The first form of this check asked only
    // "does any prop name a key the sibling lacks", which is VACUOUS here: the
    // overlay rule makes EVERY magnifier preset write `cornerRadius` and EVERY
    // demo_magnify preset write the per-axis zooms, so every name in both families
    // was "justified" and no drift could ever fail it. So a key the sibling lacks
    // counts only when the preset sets it AWAY FROM ITS OWN DEFAULT — that is what
    // distinguishes "this row exists because it uses a capability the sibling has
    // not got" from "this row mentions that capability because the overlay rule
    // makes it". A select value the sibling's own row does not offer counts
    // unconditionally, since that IS the capability.
    for (const [mine, theirs, mineType, theirsType] of [[A, B, a, b], [B, A, b, a]]) {
      const own = registry.get(mineType).defaults ?? {};
      const sibling = registry.get(theirsType);
      const options = new Map((sibling.inspector ?? []).filter((r) => r.options).map((r) => [r.key, new Set(r.options)]));
      for (const [name, preset] of mine) {
        if (theirs.has(name)) continue;
        const reasons = Object.entries(preset.props).filter(([key, value]) =>
          (options.has(key) && !options.get(key).has(value)) ||
          (!(key in (sibling.defaults ?? {})) && value !== own[key]));
        assert.ok(reasons.length > 0,
          `${mineType} ships "${name}" and ${theirsType} does not, but it uses no capability ${theirsType} lacks — every prop it moves off its own default is expressible there too. An unpaired name with no schema reason is drift between two tables meant to read alike: either pair it, or make it use the capability its absence claims.`);
      }
    }
    console.log(`      ${a} <-> ${b}: ${shared.length} names shared, ${A.size - shared.length}+${B.size - shared.length} justified by schema`);
  }
});

// ── (4) DISTINCTNESS IN PIXELS, DEFAULTS INCLUDED ────────────────────────────
// The bar is the ONE bound derivable without judgement: `indistinguishable` is true
// when no colour channel anywhere differs by a full 8-bit code value, i.e. when no
// display can show the pair apart. A family whose narrowest margin sits near it is
// reported by number, so a reader sees two rows converging before they collide.
for (const subject of SUBJECTS) {
  const plugin = registry.get(subject.type);
  const frames = [{ name: "(widget defaults)", png: await frameOf(subject, {}, `${subject.type}__defaults`) }];
  for (const preset of plugin.presets)
    frames.push({ name: preset.name, png: await frameOf(subject, preset.props, `${subject.type}__${preset.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`) });

  test(`(4) ${subject.type}: all ${plugin.presets.length} presets AND the widget defaults render pairwise distinct`, () => {
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++)
        assert.ok(!indistinguishable(imageDistance(frames[i].png, frames[j].png)),
          `${subject.type}: "${frames[i].name}" and "${frames[j].name}" render as the SAME picture — one preset wearing two names, or (if one of them is the widget defaults) a dead row. Move the DEFAULT, never the sourced preset.`);
    const closest = closestPair(frames);
    console.log(`      narrowest margin: "${closest.a}" vs "${closest.b}" — meanAbs ${closest.distance.meanAbs.toFixed(3)}, maxAbs ${closest.distance.maxAbs}, area ${(closest.distance.fraction * 100).toFixed(1)}%`);
  });
}

console.log(`\n${passed} checks passed over ${SUBJECTS.length} widgets; shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
