/**
 * ONE CHROME CLASS FOR EVERY NODE (workstream NODECHROME_).
 * Run: node src/demo_apps/PowerRP/tests/node_chrome_unify_test.js
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * USER, verbatim, over a screenshot of a band-less "Schmitt Trigger" sitting
 * beside a properly banded "Audio VCV Bogaudio Reftone":
 *
 *   "why is the text title on the audio nodes fine but schmitt trigger not?
 *    Why are they not all the same class? That sounds like bad class management"
 *
 * It was exactly bad class management. `core/node_chrome.js` carried TWO card
 * implementations: `familyCard`/`familyRim`, which the audio and control families
 * emitted, and `nodeCard`/`nodeRim`, a thinner copy the trigger roster and the
 * number/math/compare/time/display five emitted. The copies had silently diverged:
 *
 *   THE TITLE'S Y. `familyCard` typesets at `titleLineTop()`; the thin copy still
 *     used `NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3`, the arithmetic that function's
 *     own docblock records as a BUG — a text op's `y` is its line box's TOP, not a
 *     baseline, so the title's line ran 16..30.4 in a 24-unit header and hung BELOW
 *     its own strip. That is the difference the user photographed.
 *   THE BAND AND THE MARK. The thin card passed no family, so it wore the NEUTRAL
 *     fallback — the ABSENCE of a family rather than a family — and got neither the
 *     header tint nor the vector emblem.
 *   THE TITLE'S `boxW`. No box, so a long name had nothing to clip against.
 *
 * ── WHY THE PIN IS A CENSUS AND NOT A PICTURE ───────────────────────────────
 * A test asserting "the Schmitt card has a band" would pass the day it was written
 * and say nothing about the node someone adds tomorrow — and tomorrow's node is the
 * whole problem, because the thin path was never CHOSEN by any of these plugins.
 * They got it by DEFAULT: `nodeCard` was what the neighbouring file called, so it
 * was what the next author copied. Six widgets inherited a defect nobody decided on.
 *
 * So the assertion sweeps the REGISTERED ROSTER and asks each node widget's own
 * `emit()` what it actually produced. A new node that routes its header anywhere
 * but the shared seam reds this file on the day it lands, whatever it looks like.
 *
 * ── AND WHY IT INTERROGATES OPS RATHER THAN GREPPING SOURCE ─────────────────
 * The brief asked for "a grep for title-drawing outside the shared chrome function
 * should find nothing", and there IS a source-level check below — but it is the
 * weaker half and is written as a backstop, not as the pin. A grep cannot see a
 * plugin that builds its own header out of `rect` + `text` under different local
 * names, which is the form the next divergence would actually take. Reading the
 * emitted display list catches that: a card's header IS three ops in a fixed order,
 * and a hand-rolled one differs from the shared one's output no matter how it was
 * spelled.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { allPlugins } from "../plugins/index.js";
import { isNodeWidget } from "../core/nodeflow.js";
import { audioPlugins } from "../plugins/audio_index.js";
import { execPlugins } from "../plugins/exec_index.js";
import { AUDIO_SPECS } from "../core/audio_specs.js";
import {
  NODE_BODY, NODE_FAMILIES, NODE_FAMILY_NAMES, NODE_HEADER, NODE_HEADER_H,
  NODE_MARK_SIZE, NODE_RIM, NODE_TITLE_SIZE,
  familyCard, familyMarkOps, familyRim, nodeCard, nodeFamily, nodeRim, titleLineTop,
} from "../core/node_chrome.js";
import { parsePaint } from "../render_gpu/ir.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

/** Every REGISTERED node widget, which is what the census is a census OF. Asked of
 *  `isNodeWidget` (does it declare ports?) rather than of a hand-kept type list —
 *  a list is a thing an author can forget to join, and forgetting is the failure
 *  mode this file exists to catch. */
const nodeWidgets = allPlugins.filter((p) => isNodeWidget(p));

/** THE ONE EXEMPTION, BY NAME AND WITH ITS REASON. The visual node (Round 8, user,
 *  2026-08-21) has "a customizable name, colour and shape (card, rounded / chamfered
 *  rectangle, circle or oval, diamond, triangle)" — a diamond cannot emit a rect body,
 *  and an author-picked header colour is not a family. The ruling this census encodes
 *  was about WORKING nodes wearing a band-less card by accident, not by ask; so the
 *  card roster is every node widget but that one, and the check below pins that its
 *  card SHAPE still typesets its title through the shared seam. */
const VISUAL_NODE_TYPE = "visual_node";
const cardWidgets = nodeWidgets.filter((p) => p.type !== VISUAL_NODE_TYPE);

/** THE TINT → FAMILY LOOKUP, built once. `ir.js` parses every colour to RGBA floats
 *  at op construction, so an emitted header's `fill` is compared to a family's
 *  declared hex THROUGH the same parse rather than against a hand-written tuple
 *  that could drift. */
const byHeaderTint = new Map(NODE_FAMILY_NAMES.map((n) => [JSON.stringify(parsePaint(NODE_FAMILIES[n].header)), n]));

/** A state a card can actually be drawn at: the plugin's own defaults, which is the
 *  size it is BORN at and therefore the one a reader sees first. */
const stateOf = (plugin) => ({ ...plugin.defaults });

/**
 * Pure function. The ops a plugin's `emit()` produces at its default size.
 *
 * `emit(state, target, world)` — the third argument is the world transform the
 * effects halo maps through, and identity is the honest value for a card sitting
 * unrotated at its own origin.
 *
 * @param {object} plugin - a registered plugin
 * @returns {object[]} its display-list commands, LOCAL coords
 *
 * @example // emittedOps(nodeDisplayPlugin)[0].op // "rect"  (the card body)
 */
function emittedOps(plugin) {
  const world = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return plugin.emit(stateOf(plugin), null, world) ?? [];
}

/**
 * Pure function. The leading ops of a display list with any wrapper stripped, so a
 * plugin that composites its card inside a group/effect subtree is read the same way
 * as one that does not.
 *
 * `applyEffects` returns the ops UNCHANGED when a widget has no active effect (which
 * is every node at its defaults), so this is a no-op today — it exists so that a
 * future node whose defaults DO carry an effect is still censused rather than
 * silently skipped.
 *
 * @param {object[]} ops - a display list
 * @returns {object[]} the ops, unwrapped
 *
 * @example cardOps([{op: "rect"}]).length // 1
 * @example // a wrapped list is unwrapped to the child card
 * @example cardOps([{op: "pushLayer", children: [{op: "rect"}]}]).length // 1
 */
function cardOps(ops) {
  if (ops.length === 1 && Array.isArray(ops[0]?.children)) return cardOps(ops[0].children);
  return ops;
}

// ── THE CENSUS ──────────────────────────────────────────────────────────────

check("THE ROSTER IS NOT EMPTY — a census over nothing passes vacuously", () => {
  // The failure this guards is a refactor that renames the barrel or changes
  // `isNodeWidget`, after which every sweep below would pass by iterating zero
  // plugins. The count is asserted as a FLOOR rather than a number so that adding
  // nodes — the normal event — does not red this file.
  assert.ok(nodeWidgets.length >= 30, `expected the node roster; got ${nodeWidgets.length}`);
  // and the three rosters that make it up are all represented
  assert.ok(audioPlugins.length >= 20, `audio roster: ${audioPlugins.length}`);
  assert.ok(execPlugins.length >= 10, `trigger roster: ${execPlugins.length}`);
  for (const p of [...audioPlugins, ...execPlugins])
    assert.ok(nodeWidgets.includes(p), `${p.type} is in a node barrel but not in the census`);
});

check("EVERY node widget emits the SHARED CARD as its first three ops", () => {
  // THE STRUCTURAL PIN. A card is: body rect, header rect, header-square-off rect —
  // in that order, at that geometry. This is what `familyCard` produces and the only
  // thing it produces, so a plugin whose first three ops match it routed through the
  // seam, and one that hand-rolled a header does not, however it was spelled.
  const bodyFill = parsePaint(NODE_BODY);
  for (const p of cardWidgets) {
    const ops = cardOps(emittedOps(p));
    assert.ok(ops.length >= 4, `${p.type} emitted ${ops.length} ops — too few to be a card`);
    const [body, header, squareOff] = ops;
    assert.equal(body.op, "rect", `${p.type}: first op must be the card BODY`);
    assert.deepEqual(body.fill, bodyFill,
      `${p.type}: the body must be the ONE shared NODE_BODY — a tinted body is the gaudy failure the family ruling forbids`);
    assert.equal(body.y, 0, `${p.type}: the body starts at the card's top`);

    assert.equal(header.op, "rect", `${p.type}: second op must be the HEADER BAND`);
    assert.equal(header.y, 0, `${p.type}: the header band sits at the card's top`);
    assert.equal(header.h, NODE_HEADER_H,
      `${p.type}: the header band must be NODE_HEADER_H tall — this is the band the user found missing`);

    assert.equal(squareOff.op, "rect", `${p.type}: third op squares off the header's rounded bottom`);
    assert.equal(squareOff.y, NODE_HEADER_H - body.cornerRadius,
      `${p.type}: the square-off rect must meet the header's bottom edge`);
    assert.deepEqual(squareOff.fill, header.fill,
      `${p.type}: the square-off must be the header's own colour or the seam shows`);
  }
});

check("EVERY node widget's TITLE is typeset by the shared seam, at titleLineTop()", () => {
  // THE EXACT DEFECT. The thin card typeset at `NODE_HEADER_H/2 + NODE_TITLE_SIZE/3`
  // = 16, so a 12pt line (14.4 tall) ran to 30.4 in a 24-unit header — the title
  // hanging below its own strip that the user photographed. `titleLineTop()` is 4.8
  // and the line ends at 19.2, inside the band.
  const THE_OLD_WRONG_Y = NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3;
  for (const p of cardWidgets) {
    const ops = cardOps(emittedOps(p));
    const title = ops[3];
    assert.equal(title.op, "text", `${p.type}: the fourth op must be the card TITLE`);
    assert.equal(title.size, NODE_TITLE_SIZE, `${p.type}: the title is chrome and wears the chrome size`);
    assert.equal(title.bold, true, `${p.type}: the title is bold in the shared seam`);
    assert.equal(title.y, titleLineTop(),
      `${p.type}: the title must sit on titleLineTop() — it is at ${title.y}, and ${THE_OLD_WRONG_Y} is the retired thin card's wrong value`);
    assert.notEqual(title.y, THE_OLD_WRONG_Y, `${p.type} regressed onto the thin card's title y`);
    assert.ok(String(title.text ?? "").length > 0, `${p.type}: a card with no name in its band is the band-less card again`);
  }
});

check("EVERY node widget DECLARES A FAMILY — the band, the tint and the mark", () => {
  // THE ONE-CLASS REQUIREMENT, in its positive form. Passing NO family is legal at
  // the function level (a plugin asset may name one that does not exist, and must
  // degrade rather than throw) but it is NOT legal for a registered node: the
  // neutral fallback IS the band-less card, so a roster member wearing it is the
  // defect, not a style choice.
  const neutralHeader = parsePaint(NODE_HEADER);
  for (const p of cardWidgets) {
    const ops = cardOps(emittedOps(p));
    const header = ops[1];
    assert.notDeepEqual(header.fill, neutralHeader,
      `${p.type} wears the NEUTRAL header — it declares no family, which is exactly the band-less card the user filed`);
    const fam = byHeaderTint.get(JSON.stringify(header.fill));
    assert.ok(fam, `${p.type}'s header tint matches no declared family — it invented its own colour`);
  }
});

check("EVERY node widget emits its family MARK, and the mark is a PATH not a character", () => {
  // The CA lesson (tests/node_resize_chrome_test.js) generalized to the whole
  // roster: the emblem must be vector, because a typeset glyph depends on font
  // coverage and the same display list is painted by Skia, the PDF and SVG
  // exporters, and bare-node cli/render.js.
  for (const p of cardWidgets) {
    const ops = cardOps(emittedOps(p));
    const mark = ops[4];
    assert.equal(mark?.op, "path", `${p.type}: the fifth op must be the family MARK, drawn as a path`);
    assert.ok(typeof mark.d === "string" && mark.d.startsWith("M "), `${p.type}: the mark must be a real path`);
    // AND IT LANDS INSIDE THE HEADER STRIP. Checked by rebuilding the mark through
    // familyMarkOps at the same state and asserting equality, rather than by parsing
    // coordinates out of `d` — an arc's seven parameters are not x/y pairs, so a
    // naive alternation reads its FLAGS as ordinates and mis-measures the ring mark
    // on audio_output. Equality against the shared placer is the stronger claim
    // anyway: it says the mark is placed by the ONE function whose own tests
    // (node_resize_chrome_test) pin the strip arithmetic.
    const familyName = byHeaderTint.get(JSON.stringify(ops[1].fill));
    assert.deepEqual(JSON.parse(JSON.stringify([mark])),
      JSON.parse(JSON.stringify(familyMarkOps(stateOf(p), familyName))),
      `${p.type}: the mark is not the one familyMarkOps places for family "${familyName}"`);
  }
});

check("EVERY node widget's RIM is its family's, emitted LAST", () => {
  // The rim draws over the header seam and over any bead that straddles the edge,
  // which is what makes the card read as a container rather than as a stack. A node
  // that emits it early gets a bead drawn over its own rim.
  const neutralRim = parsePaint(NODE_RIM);
  const familyRims = new Set(NODE_FAMILY_NAMES.map((n) => JSON.stringify(parsePaint(NODE_FAMILIES[n].rim))));
  for (const p of cardWidgets) {
    const ops = cardOps(emittedOps(p));
    const last = ops[ops.length - 1];
    assert.equal(last.op, "rect", `${p.type}: the last op must be the card RIM`);
    assert.equal(last.fill, null, `${p.type}: the rim is a stroke, not a fill`);
    assert.notDeepEqual(last.stroke, neutralRim, `${p.type}: a family node wearing the neutral rim declares no family`);
    assert.ok(familyRims.has(JSON.stringify(last.stroke)), `${p.type}: the rim matches no declared family`);
  }
});

check("THE VISUAL NODE's card shape typesets its title through the shared seam", () => {
  // The exemption above is not a licence to drift. At its default — the "card"
  // shape — the visual node draws a title strip, and that strip's title must sit
  // exactly where familyCard puts one: the y the user photographed wrong is the one
  // value this whole file exists to keep unreachable.
  const visual = nodeWidgets.find((p) => p.type === VISUAL_NODE_TYPE);
  assert.ok(visual, "visual_node must be registered — it is the exemption's subject");
  assert.equal(visual.defaults.shape, "card", "the exemption's positive check reads the card shape, which must be the default");
  const ops = cardOps(emittedOps(visual));
  const title = ops.find((o) => o.op === "text");
  assert.ok(title, "the card shape draws its label as a title");
  assert.equal(title.y, titleLineTop(), `visual_node's card title sits at ${title.y}, not titleLineTop()`);
  assert.equal(title.size, NODE_TITLE_SIZE);
  assert.equal(title.bold, true);
  assert.notEqual(title.y, NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3, "visual_node regressed onto the thin card's title y");
});

// ── ONE NODE PER FAMILY ACTUALLY EXISTS ─────────────────────────────────────

check("every declared family is worn by a real registered node — no colour nobody sees", () => {
  // The whole-roster form of the claim tests/audio_nodes_test.js makes for the audio
  // half. An unused family is a colour that exists only in the table, which is the
  // same waste in either direction — and it is the check that would have caught the
  // three new families being declared without being wired to anything.
  const worn = new Set();
  for (const p of cardWidgets) {
    const fam = byHeaderTint.get(JSON.stringify(cardOps(emittedOps(p))[1].fill));
    if (fam) worn.add(fam);
  }
  assert.deepEqual([...worn].sort(), NODE_FAMILY_NAMES.slice().sort(),
    "a declared family that no node wears, or a node wearing something undeclared");
});

check("the three NON-AUDIO families are worn by the nodes NODECHROME_ was filed about", () => {
  // Named explicitly, because the generic sweep above would still pass if the
  // trigger roster wore, say, "modulation" — which would be wrong in a way only a
  // reader would notice: a Gate is not an LFO, and the two must sort apart.
  const headerOf = (p) => JSON.stringify(cardOps(emittedOps(p))[1].fill);
  const want = (name) => JSON.stringify(parsePaint(NODE_FAMILIES[name].header));

  // THE NODE FROM THE SCREENSHOT.
  const schmitt = nodeWidgets.find((p) => p.type === "node_schmitt");
  assert.ok(schmitt, "node_schmitt must be registered — it is the widget the ruling names");
  assert.equal(headerOf(schmitt), want("trigger"), "the Schmitt Trigger wears the trigger band");

  for (const p of execPlugins)
    assert.equal(headerOf(p), want("trigger"), `${p.type} is a trigger node and must wear the trigger family`);

  for (const type of ["node_number", "node_math", "node_compare", "node_time"]) {
    const p = nodeWidgets.find((x) => x.type === type);
    assert.ok(p, `${type} must be registered`);
    assert.equal(headerOf(p), want("math"), `${type} computes a value and must wear the math family`);
  }
  const display = nodeWidgets.find((p) => p.type === "node_display");
  assert.equal(headerOf(display), want("display"), "the Display node wears the display family");
});

// ── THE AUDIO NODES MUST NOT HAVE MOVED ─────────────────────────────────────

check("AUDIO NODES ARE BYTE-IDENTICAL — their band already WAS the standard", () => {
  // The constraint on this workstream: the audio family is what everything else was
  // being unified TOWARD, so if any of it changed, the change went the wrong way.
  // Asserted on three representative modules across three families, by full op-list
  // equality against `familyCard` called directly with the module's own family.
  // The family lives in the module's SPEC (the plugin closes over it and does not
  // re-expose it), so AUDIO_SPECS is the honest place to read it from. Reading it
  // from the emitted op instead would make this check circular — it would compare
  // the card against a familyCard call parameterized BY that same card.
  const representatives = ["audio_reverb", "audio_filter", "audio_meter"];
  for (const type of representatives) {
    const p = nodeWidgets.find((x) => x.type === type);
    assert.ok(p, `${type} must be registered for this pin to mean anything`);
    const spec = AUDIO_SPECS.find((x) => x.type === type);
    assert.ok(spec?.family, `${type} must have a spec declaring its family`);
    const s = stateOf(p);
    const ops = cardOps(emittedOps(p));
    // The card's five leading ops must EQUAL familyCard's own output for this state.
    const want = familyCard(s, p.title, spec.family);
    const head = ops.slice(0, want.length);
    assert.deepEqual(JSON.parse(JSON.stringify(head)), JSON.parse(JSON.stringify(want)),
      `${type}'s card head diverged from familyCard — the audio band is the standard and must not have moved`);
    // and its rim is familyRim's, unchanged
    assert.deepEqual(JSON.parse(JSON.stringify(ops[ops.length - 1])),
      JSON.parse(JSON.stringify(familyRim(s, spec.family)[0])),
      `${type}'s rim diverged from familyRim`);
  }
});

check("the six ORIGINAL family entries are untouched by the three new ones", () => {
  // A regression here would mean the new families were added by editing the old
  // ones' values rather than by appending — which would silently restyle 23 audio
  // modules while claiming to fix the trigger roster.
  assert.equal(NODE_FAMILIES.source.header, "#3a3020");
  assert.equal(NODE_FAMILIES.source.rim, "#7a6338");
  assert.equal(NODE_FAMILIES.filter.header, "#1e3330");
  assert.equal(NODE_FAMILIES.effect.header, "#2b2440");
  assert.equal(NODE_FAMILIES.effect.rim, "#6b5aa8");
  assert.equal(NODE_FAMILIES.modulation.header, "#1f2b40");
  assert.equal(NODE_FAMILIES.analysis.header, "#1f3326");
  assert.equal(NODE_FAMILIES.output.header, "#3a2430");
  assert.equal(NODE_FAMILIES.output.rim, "#a8557a");
  // and the neutral fallback is still the plain look, for the asset-typo case
  assert.equal(nodeFamily().header, NODE_HEADER);
  assert.equal(nodeFamily("nonsense").rim, NODE_RIM);
  assert.equal(nodeFamily().mark, null);
});

check("the new families obey the table's OWN discipline: distinct, dark, marked", () => {
  const NEW = ["trigger", "math", "display"];
  for (const name of NEW) {
    const f = NODE_FAMILIES[name];
    assert.ok(f, `${name} must be declared`);
    assert.match(f.header, /^#[0-9a-f]{6}$/i, `${name}'s header must be a hex literal — the painter cannot resolve a CSS var`);
    assert.match(f.rim, /^#[0-9a-f]{6}$/i);
    assert.ok(f.label, `${name} needs a human label`);
    assert.ok(f.mark && f.mark.startsWith("M "), `${name} needs a unit-box vector mark`);
    // DARK: the header tint is a small step off NODE_HEADER, not a saturated hue.
    // Measured as a luminance ceiling — the table's rule is "desaturated and dark",
    // and a light header would be the candy wall the ruling forbids.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(f.header.slice(i, i + 2), 16));
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    assert.ok(luma < 0.3, `${name}'s header is too light (luma ${luma.toFixed(3)}) — the tints are dark steps off NODE_HEADER`);
  }
  // DISTINCT: no two families anywhere share a tint, a rim or a mark. (audio_nodes_test
  // asserts this too; it is repeated here because the NEW entries are this file's
  // subject and a collision introduced by them must red THIS file.)
  const headers = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].header);
  assert.equal(new Set(headers).size, headers.length, "two families share a header tint — they would not sort");
  const rims = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].rim);
  assert.equal(new Set(rims).size, rims.length);
  const marks = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].mark);
  assert.equal(new Set(marks).size, marks.length, "the mark is the colour-blind-safe channel; duplicates defeat it");
});

// ── THE THIN PATH IS GONE ───────────────────────────────────────────────────

check("nodeCard / nodeRim ARE the family seam — not a second implementation", () => {
  // They survive as NAMES (a caller may legitimately want the neutral look) but they
  // must not be a second card. Asserted by equality of output, which is the only form
  // of the claim a future edit to either cannot slip past.
  const s = { w: 140, h: 90 };
  assert.deepEqual(JSON.parse(JSON.stringify(nodeCard(s, "Plain"))), JSON.parse(JSON.stringify(familyCard(s, "Plain"))));
  assert.deepEqual(JSON.parse(JSON.stringify(nodeRim(s))), JSON.parse(JSON.stringify(familyRim(s))));
  // and they forward a family, so a caller of the old name still gets a band
  assert.deepEqual(JSON.parse(JSON.stringify(nodeCard(s, "Gate", "trigger"))), JSON.parse(JSON.stringify(familyCard(s, "Gate", "trigger"))));
  // THE TITLE Y IS THE POINT: the old thin card's wrong value is now unreachable.
  assert.equal(nodeCard(s, "Plain")[3].y, titleLineTop());
});

check("BACKSTOP: no plugin draws its own header band or title text", () => {
  // The brief's grep, written as the WEAKER half of the pin deliberately — the op
  // sweeps above are the real assertion, because a hand-rolled header spelled with
  // local names would pass this and fail those. What this adds is a readable
  // statement of the rule at the SOURCE level, which is where an author works.
  //
  // The rule: a node plugin may not construct a text op at the title's size, nor a
  // rect at the header's height, in its own file. Both belong to familyCard.
  // (`visual_node.js` is outside the `node_*` glob and draws its own strip BY ASK —
  // the same exemption `cardWidgets` states above, not a hole.)
  const pluginDir = join(HERE, "..", "plugins");
  const offenders = [];
  for (const file of readdirSync(pluginDir).filter((f) => f.startsWith("node_") && f.endsWith(".js"))) {
    const src = readFileSync(join(pluginDir, file), "utf8");
    // A header band is a rect whose height is the header constant.
    if (/\brect\(\{[^}]*\bh:\s*NODE_HEADER_H\b/.test(src)) offenders.push(`${file}: builds its own header band`);
    // A title is a text op at the title size. (node_keyboard.js legitimately reads
    // NODE_HEADER_H for its OWN content's top — reading the constant is fine; drawing
    // the band with it is not.)
    if (/\btext\(\{[^}]*\bsize:\s*NODE_TITLE_SIZE\b/.test(src)) offenders.push(`${file}: typesets its own title`);
  }
  assert.deepEqual(offenders, [], `these plugins draw chrome that belongs to familyCard:\n  ${offenders.join("\n  ")}`);
});

check("BACKSTOP: core's node factories route through the family seam", () => {
  // The three factories are where a whole FAMILY of widgets gets its card, so a thin
  // call here is worth eleven plugins' worth of defect — which is precisely how the
  // trigger roster acquired one.
  for (const file of ["exec_nodes.js", "audio_nodes.js", "control_nodes.js"]) {
    const src = readFileSync(join(HERE, "..", "core", file), "utf8");
    assert.ok(!/\.\.\.nodeCard\(/.test(src), `core/${file} still emits the thin nodeCard — it must call familyCard with its family`);
    assert.ok(!/\.\.\.nodeRim\(/.test(src), `core/${file} still emits the thin nodeRim`);
  }
});

console.log(`node_chrome_unify_test: ${passed} checks passed`);
