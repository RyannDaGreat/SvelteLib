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
import { createRegistry, presetFamiliesOf } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
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
// opacity and the universal effect knobs no subject family models.
//
// THE EFFECTS HALF IS A DELIBERATE SUBSET AND IT IS NOT DERIVABLE FROM THE BUNDLE.
// Three of the six universal effects ARE looks for these subjects and are therefore
// absent from this list: clock_digital writes `bloom` (a lit VFD/CRT display IS a
// glow) and progress_bar writes `shadow`, `innerShadow` and `bloom` (an inset track
// with a raised fill is what a physical gauge looks like). The other three
// — softEdges, blendMode, and now gaussianBlur — are modelled by NO subject family,
// so writing one would be a preset reaching past its own look.
//
// I TRIED TO DERIVE THIS SET FROM BUNDLES.effects, which is the correct move in the
// three sibling suites whose families model no effect at all, and it failed here
// twice in a row — first 'clock_digital "Bedside Alarm" writes bloom (composition)',
// then 'progress_bar "System Track" writes shadow; innerShadow'. That is the useful
// result: whether a given effect is a LOOK is a judgement about a particular widget,
// which no `map` over the bundle can make. So a NEW effect must be judged the same
// way and added here by hand if no family models it — as gaussianBlur is, since a
// blurred gauge or clock is an out-of-focus one.
//
// The COMPLETENESS half needs no such judgement and is not at risk: check (1) below
// asks only that a family's rows AGREE with each other, so a bundle key no row
// writes is simply not required of any of them.
const COMPOSITION_KEYS = new Set([
  "type", "x", "y", "cx", "cy", "w", "h", "z", "rotation", "scale", "rotationAnchor",
  "opacity", "softEdges", "blendMode", "gaussianBlur",
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
 * `reading` is the value a LOOK family needs on screen to be comparable at all — a
 * progress bar at fraction 0 emits no fill op, so ten looks would be ten tracks. It
 * is applied ONLY to the look family: a family that OWNS the reading key must be
 * scored against the widget's GENUINE untouched default, or the C-16 baseline is a
 * value this test invented rather than one the widget ships.
 *
 * @param {object} subject - a SUBJECTS entry
 * @param {object} props - the preset's props (empty for the defaults baseline)
 * @param {boolean} withReading - apply the subject's `reading` override
 * @returns {object} a PowerRP document
 */
function docOf(subject, props, withReading) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: BACKGROUND });
  (subject.backdrop ?? []).forEach((spec, i) => { items[`bg${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  items.subject = { ...registry.get(subject.type).defaults, type: subject.type, ...subject.frame, ...(withReading ? subject.reading : {}), ...props };
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
 * @param {number|null} atSeconds - presentation-clock override; null = the editor freeze
 * @param {boolean} withReading - see docOf
 * @returns {Promise<{width: number, height: number, data: Buffer}>} the decoded frame
 */
async function frameOf(subject, props, label, atSeconds, withReading) {
  // A TIMING preset is a function of the presentation clock, and the editor's clock
  // is FROZEN — so scoring one family at one instant would call two different
  // behaviours the same picture. setParticleTimeOverride is the seam the determinism
  // probes already use to render an exact frame; null restores the freeze.
  setParticleTimeOverride(atSeconds);
  const doc = docOf(subject, props, withReading);
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
    lookFamily: "presets",
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
    lookFamily: "presets",
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
    lookFamily: "presets",
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
    lookFamily: "presets",
    frame: LENS_FRAME,
    backdrop: lensBackdrop(),
    excluded: {
      "origin": "THE TARGET — as on the canonical magnifier",
      "shadow": "a backdrop sampler's effect substrate is unverified — as on the canonical magnifier",
      "bloom": "as shadow", "innerShadow": "as shadow",
    },
  },
  {
    type: "progress_bar",
    frame: { x: 80, y: 235, w: 800, h: 70 },
    // At fraction 0 the widget emits NO fill op at all, so a look family scored on a
    // freshly-placed bar would be comparing ten TRACKS. A mid reading puts both
    // regions on screen. A timing preset overrides it, which is the point of that
    // family; the baseline keeps it.
    reading: { fraction: 0.62 },
    // core/registry.js NAMESPACES a declared family as "presets.<id>", so a family
    // cannot collide with a pool group; this is that resolved id, not the raw one.
    lookFamily: "presets.looks",
    // A timing preset is a function of the presentation clock, so one instant cannot
    // tell two of them apart. Three: the editor's own freeze (2s, the only instant an
    // author ever hover-previews at), one mid-run, and one past the short spans.
    sampleTimes: { "presets.timing": [2, 6, 12] },
    excluded: {
      fraction: "THE READING, and the TIMING family's whole content — usually bound to a scrubber's progress export",
      orientation: "not a look but an AXIS, and the axis is meaningless without the box aspect the author dragged (a preset cannot set w/h)",
    },
  },
  {
    type: "clock_analog",
    // ONE look key, `preset`: see the excluded map below for why that is correct here.
    minLookKeys: 1,
    // Square: the dial is inscribed in min(w, h), so a wide box would just add margin.
    frame: { x: 250, y: 20, w: 500, h: 500 },
    // A time whose three hands point in three clearly different directions, so a
    // hand-width or taper difference between two dials is not hidden by overlap.
    reading: { time: 10 * 3600 + 8 * 60 + 32 },
    lookFamily: "presets",
    // `classic` IS DEFAULT_PRESET and the byte-frozen baseline, so its card renders
    // exactly the untouched widget — declared here so check (5) ASSERTS that rather
    // than reporting it as a dead row. See BASELINE_ROW.
    restoresDefaults: "Classic",
    // THIS WIDGET IS THE ODD ONE OUT and its excluded map is nearly the whole
    // schema: its presets write ONE key, `preset`, and the twelve style values
    // follow by DERIVATION (resolveStyle, re-run every render) rather than by being
    // splatted into state. That is not a violation of the overlay rule, it is
    // immune to it — with one key there is no key left over for a hover to strand.
    // So the look-key derivation must be told that everything else is out, and the
    // reason is one shipped decision rather than twelve separate judgements.
    excluded: Object.fromEntries([
      ["time", "THE READING — the whole point of the widget, usually bound `= time`"],
      ...["numerals", "numeralInset", "numeralFont", "numeralSize", "numeralColor", "showTicks",
        "majorTickWidth", "majorTickLength", "showMinorTicks", "minorTickWidth", "minorTickLength",
        "tickColor", "handBezel", "showSecondHand", "secondHandTaper",
        "hourHandColor", "hourHandWidth", "hourHandLength",
        "minuteHandColor", "minuteHandWidth", "minuteHandLength",
        "secondHandColor", "secondHandWidth", "secondHandLength",
        "fill", "stroke", "strokeWidth", "shadow", "bloom", "innerShadow",
      ].map((k) => [k, "derived from `preset`, not written by a card — the widget's own model, and its rule that a preset restyles the DIAL without repainting a chosen palette"]),
    ]),
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
test("(1) within every family, all presets write the IDENTICAL key set", () => {
  // The overlay rule stated exactly, and it is universal — it holds for a
  // whole-look family and a one-key sub-aspect family alike. Derived from the
  // family itself, so it needs no per-widget list and cannot go stale.
  for (const subject of SUBJECTS)
    for (const family of presetFamiliesOf(registry.get(subject.type))) {
      const signature = (preset) => Object.keys(preset.props).sort().join(", ");
      const first = family.presets[0];
      for (const preset of family.presets)
        assert.equal(signature(preset), signature(first),
          `${subject.type}/${family.id}: "${preset.name}" writes {${signature(preset)}} but "${first.name}" writes {${signature(first)}} — application is an OVERLAY, so the key one of them omits keeps whatever the previously HOVERED row left there and these two rows' renders become hover-order dependent`);
    }
});

test("(2) the WHOLE-LOOK family covers every look knob the widget offers", () => {
  // The stronger half, and the one that keeps working as the widget grows: the look
  // set is DERIVED from the live inspector minus the subject's EXCLUDED map, so a
  // knob added tomorrow joins the demand with no edit here and the excluded map is
  // where each family's judgements are written down and pinned.
  for (const subject of SUBJECTS) {
    const plugin = registry.get(subject.type);
    const want = lookKeys(plugin, subject.excluded);
    // A floor, so a derivation bug that returned nothing could not pass as a
    // satisfied demand. Most widgets carry many look knobs; a subject that
    // legitimately has one declares so with its reason (clock_analog, whose cards
    // write the single `preset` key and derive the rest).
    const floor = subject.minLookKeys ?? 4;
    assert.ok(want.length >= floor, `${subject.type}: only ${want.length} look keys derived (floor ${floor}) — lookKeys is mis-deriving, so this check would be near-vacuous`);
    const family = presetFamiliesOf(plugin).find((f) => f.id === subject.lookFamily);
    assert.ok(family, `${subject.type} declares no family "${subject.lookFamily}" — the subject's lookFamily id and the plugin's declaration disagree`);
    for (const preset of family.presets) {
      const missing = want.filter((k) => !(k in preset.props));
      assert.deepEqual(missing, [], `${subject.type} "${preset.name}" omits ${missing.join(", ")}`);
    }
    console.log(`      ${subject.type}: ${presetFamiliesOf(plugin).map((f) => `${f.id}:${f.presets.length}`).join(" ")} — ${want.length} look knobs (${want.join(", ")})`);
  }
});

// ── (3) NO COMPOSITION KEY ───────────────────────────────────────────────────
test("(3) no preset writes a composition key, and no LOOK preset writes an excluded one", () => {
  for (const subject of SUBJECTS)
    for (const family of presetFamiliesOf(registry.get(subject.type)))
      for (const preset of family.presets) {
        // Composition is forbidden everywhere; the excluded map governs the look
        // family alone, since a sub-aspect family exists precisely to own a key the
        // look family gave up (progress_bar's `fraction` is the case).
        const illegal = Object.keys(preset.props).filter((k) =>
          COMPOSITION_KEYS.has(k) || (family.id === subject.lookFamily && k in subject.excluded));
        assert.deepEqual(illegal, [],
          `${subject.type}/${family.id} "${preset.name}" writes ${illegal.map((k) => `${k} (${subject.excluded[k] ?? "composition"})`).join("; ")}`);
      }
});

// ── (4) SIBLING PAIRING, DERIVED RATHER THAN LISTED ──────────────────────────
test("(4) a preset name unique to one sibling is one the OTHER's schema cannot express", () => {
  for (const [a, b] of PAIRED_FAMILIES) {
    const of = (type) => new Map(presetFamiliesOf(registry.get(type)).flatMap((f) => f.presets).map((p) => [p.name, p]));
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

// ── (5) DISTINCTNESS IN PIXELS, DEFAULTS INCLUDED ────────────────────────────
// THE BASELINE IS ROW 0 of every table (see `rows` below), and a subject may name
// ONE preset that is ALLOWED to equal it — `restoresDefaults`.
//
// C-16 says a preset rendering identically to the untouched widget is a dead row
// and the DEFAULT should move, never the sourced preset. That remedy has an
// exception and clock_analog is it: its `classic` preset IS the widget's default
// look BY CONTRACT — the plugin's own comment forbids tidying those numbers, and
// tests/clock_analog_test.js gates all-defaults emit as byte-identical to the
// frozen pre-preset geometry. Moving that default would change every existing
// document. And the row is not dead: application is an OVERLAY, so without a row
// that puts the dial back there is no way out of a preset through the pane at all
// (the same argument as progress_bar's literal "Half Full").
//
// So the exemption is written as a STRONGER assertion, not a hole: the named row
// must BE the untouched widget. Change `classic`'s values and this fails; name a
// row that is not the default and this fails; it cannot hide a real duplicate,
// because it names exactly one row against exactly one baseline.
const BASELINE_ROW = 0;
// The bar is the ONE bound derivable without judgement: `indistinguishable` is true
// when no colour channel anywhere differs by a full 8-bit code value, i.e. when no
// display can show the pair apart. A family whose narrowest margin sits near it is
// reported by number, so a reader sees two rows converging before they collide.
//
// TWO PRESETS ARE THE SAME IFF THEY AGREE AT EVERY TIME, so a family whose content
// is a function of the clock is scored at SEVERAL clock times and a pair counts as
// distinct when it differs at ANY of them. A look family declares no sample times
// and is scored once at the editor's own freeze, which is exactly the old rule.
for (const subject of SUBJECTS)
  for (const family of presetFamiliesOf(registry.get(subject.type))) {
    const times = subject.sampleTimes?.[family.id] ?? [null];
    const withReading = family.id === subject.lookFamily;
    const label = (name, t) => `${subject.type}__${family.id}__${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}${t === null ? "" : `__t${t}`}`;
    const rows = [{ name: "(widget defaults)", props: {} }, ...family.presets.map((p) => ({ name: p.name, props: p.props }))];
    // frames[timeIndex] is the whole table photographed at one clock time. Rendered
    // SEQUENTIALLY on purpose: the clock override is module state, so concurrent
    // renders would be racing one global.
    const frames = [];
    for (const t of times) {
      const shot = [];
      for (const r of rows) shot.push({ name: r.name, png: await frameOf(subject, r.props, label(r.name, t), t, withReading) });
      frames.push(shot);
    }

    test(`(5) ${subject.type}/${family.id}: all ${family.presets.length} presets AND the widget defaults render pairwise distinct${times.length > 1 ? ` (over ${times.length} clock times)` : ""}`, () => {
      for (let i = 0; i < rows.length; i++)
        for (let j = i + 1; j < rows.length; j++) {
          const same = frames.every((shot) => indistinguishable(imageDistance(shot[i].png, shot[j].png)));
          // THE ONE LEGITIMATE COLLISION, and it is asserted rather than excused.
          // See RESTORES_DEFAULTS above: the named row must BE the untouched
          // widget, so the exemption is a stronger claim than the rule it lifts.
          if (i === BASELINE_ROW && rows[j].name === subject.restoresDefaults) {
            assert.ok(same,
              `${subject.type}/${family.id}: "${rows[j].name}" is declared the RESTORE row but does NOT render as the untouched widget — either its values drifted off the default, or the declaration is stale`);
            continue;
          }
          assert.ok(!same,
            `${subject.type}/${family.id}: "${rows[i].name}" and "${rows[j].name}" render as the SAME picture at every sampled time — one preset wearing two names, or (if one of them is the widget defaults) a dead row. Move the DEFAULT, never the sourced preset; the sole exception is a declared RESTORE row.`);
        }
      // The narrowest margin is reported per clock time, because a timing family's
      // rows legitimately converge at some instants and the interesting number is
      // how close they get where they are meant to be apart.
      frames.forEach((shot, k) => {
        const closest = closestPair(shot);
        console.log(`      narrowest margin${times[k] === null ? "" : ` at t=${times[k]}s`}: "${closest.a}" vs "${closest.b}" — meanAbs ${closest.distance.meanAbs.toFixed(3)}, maxAbs ${closest.distance.maxAbs}, area ${(closest.distance.fraction * 100).toFixed(1)}%`);
      });
    });
  }

console.log(`\n${passed} checks passed over ${SUBJECTS.length} widgets; shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
