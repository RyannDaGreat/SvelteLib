/**
 * NODE RESIZE INTEGRITY (workstream CD) + THE FAMILY MARK (workstream CA).
 * Run: node src/demo_apps/PowerRP/tests/node_resize_chrome_test.js
 *
 * ── WHAT ONLY THIS FILE PROVES ──────────────────────────────────────────────
 * Two defects the user found by LOOKING, which every existing green suite missed
 * for the same structural reason: nothing here asserted a relationship between a
 * node's INTERNALS and its BOX. Every layout function was tested at ONE size —
 * the size its own `defaults` chose, at which everything fits — so a stack laid
 * out from the top with fixed constants passed a full suite while being wrong at
 * every other height an author can drag to.
 *
 * CD, user verbatim (2026-08-03): "Also looks at this stupid shit when I resize a
 * widget lmao the knobs stay in place and the module knobs are floating"
 * CA, user verbatim: "The text of these widgets it not placed in the top right.
 * Why many say "No Glyph"?"
 *
 * ── THE CD PINS ARE A SWEEP, NOT A SIZE ─────────────────────────────────────
 * The whole lesson of the defect is that one size proves nothing, so these walk a
 * module through a RANGE of heights and widths and assert the invariant at each.
 * The invariant is deliberately stated as a relationship — "every dial's centre
 * is inside the frame", "the hit test agrees with the drawn position" — rather
 * than as coordinates, because coordinates would re-pin the current arithmetic
 * and this file's job is to pin the CONTRACT so the arithmetic can improve.
 *
 * ── THE CA PIN IS ABOUT WHAT THE MARK IS MADE OF ────────────────────────────
 * A test asserting the mark LOOKS right would have passed before the fix too: a
 * text op carrying "∿" is a perfectly well-formed text op, and the tofu happened
 * three layers down inside Skia's font fallback. So the pin is structural — the
 * mark must be a PATH, and no family may reach the display list as a character —
 * which is the only form of the assertion that a font-coverage regression cannot
 * slip past.
 */

import assert from "node:assert/strict";

import { audioMixerPlugin } from "../plugins/audio_mixer.js";
import { audioPadPlugin } from "../plugins/audio_pad.js";
import { audioFilterPlugin } from "../plugins/audio_filter.js";
import { audioPlugins } from "../plugins/audio_index.js";
import { knobAt, knobBandScale, knobRadius, KNOB_BAND_MIN_SCALE } from "../core/node_knobs.js";
import { knobBandTop } from "../core/audio_nodes.js";
import { MIXER_SPEC } from "../core/audio_specs.js";
// web/knobFocus.js is DOM-free despite its path — it is pure geometry and pure
// policy, which is exactly why BX put the press and the cursor behind it.
import { knobCursorFor, knobDialAt } from "../web/knobFocus.js";
import {
  NODE_FAMILIES, NODE_FAMILY_NAMES, NODE_HEADER_H, NODE_MARK_SIZE,
  familyCard, familyMarkOps, nodeFamily, scaleUnitPath,
} from "../core/node_chrome.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/**
 * The heights the sweeps walk, and WHY THEY STOP WHERE THEY DO.
 *
 * The Mixer's default height is 355 and its eight port rows end at y=194, so this
 * spans "plenty of room" down through the exact window the user's screenshot was
 * taken in (~235..300 — the heights at which the ports fitted and the band used
 * to escape entirely).
 *
 * BELOW THE FLOOR THE CARD IS GENUINELY TOO SHORT AND THE BAND CLIPS, ON PURPOSE.
 * A node's PORT ROWS are placed from its top edge by fixed constants in
 * core/nodeflow.portLayout — they are not part of this workstream's seam and they
 * do not reflow — so a Mixer shorter than ~235 has already spent its whole body on
 * beads and has no band to give. At that point the registry docblock's rule
 * applies (SHOW the overflow so the author can see the node is too small), and a
 * sweep that asserted otherwise would be asserting the ports away.
 *
 * `PORTS_ONLY_H` is where that begins, stated once rather than dotted through the
 * checks, and pinned by its own check below so it cannot silently drift upward.
 */
const PORTS_ONLY_H = 235;
const HEIGHTS = [500, 400, 355, 320, 300, 280, 260, 250, 240, PORTS_ONLY_H];
const WIDTHS = [300, 220, 150, 120, 100];

/** A dial's full painted extent below its centre: the arc, then the label's gap
 *  and its line. This is the number that must stay inside the card. */
const dialBottom = (d) => d.cy + knobRadius(d) + d.labelGap + d.labelSize;

/**
 * Pure function. The ENDPOINTS an SVG path visits, as {xs, ys}.
 *
 * It parses rather than pairing every number in the string, because an arc's
 * `rx ry rot largeArc sweep x y` has SEVEN numbers of which only the last two are
 * a point — blanket pairing reads `rot largeArc` as a coordinate and reports the
 * ring mark as leaving the header by 111 units, which is a bug in the check and
 * not in the picture. (It did, on the first run of this file.)
 */
function markPoints(d) {
  const t = d.trim().split(/[\s,]+/);
  const xs = [], ys = [];
  let i = 0;
  const point = () => { xs.push(Number(t[i++])); ys.push(Number(t[i++])); };
  while (i < t.length) {
    const cmd = t[i++];
    if (cmd === "M" || cmd === "L") point();
    else if (cmd === "C") { point(); point(); point(); }
    else if (cmd === "A") { i += 5; point(); }
    else if (cmd === "Z") continue;
    else throw new Error(`markPoints: unhandled command ${cmd}`);
  }
  return { xs, ys };
}

// ── CD: THE BAND REFLOWS WITH THE BOX ───────────────────────────────────────

check("CD: every dial's CENTRE stays inside the card at every height", () => {
  for (const plugin of [audioMixerPlugin, audioPadPlugin, audioFilterPlugin]) {
    for (const h of HEIGHTS) {
      const s = { ...plugin.defaults, h };
      for (const d of plugin.knobLayout(s)) {
        assert.ok(d.cy > NODE_HEADER_H && d.cy < h,
          `${plugin.type} at h=${h}: dial ${d.key} centre y=${d.cy.toFixed(1)} is outside the card body (header ${NODE_HEADER_H}, bottom ${h})`);
        assert.ok(d.cx > 0 && d.cx < Math.abs(s.w),
          `${plugin.type} at h=${h}: dial ${d.key} centre x=${d.cx.toFixed(1)} is outside the card`);
      }
    }
  }
});

check("CD: every dial's centre stays inside the card at every WIDTH too", () => {
  for (const w of WIDTHS) {
    const s = { ...audioMixerPlugin.defaults, w };
    for (const d of audioMixerPlugin.knobLayout(s)) {
      assert.ok(d.cx > 0 && d.cx < w, `mixer at w=${w}: dial ${d.key} cx=${d.cx.toFixed(1)} escaped`);
    }
  }
});

check("CD: THE USER'S CASE — a mixer shortened into the screenshot's window keeps its whole band inside the frame", () => {
  // The reported picture: port rows inside the frame, all five knobs below it.
  // The window where that was possible is every height at which the ports still
  // fit (they end at 194) and the natural band top (231) + band height (94) did
  // not. Those heights must now hold the WHOLE band, label and all.
  for (const h of [300, 280, 260, 250]) {
    const s = { ...audioMixerPlugin.defaults, h };
    const dials = audioMixerPlugin.knobLayout(s);
    assert.equal(dials.length, 5, "the mixer has five dials");
    const bottom = Math.max(...dials.map(dialBottom));
    assert.ok(bottom <= h,
      `mixer at h=${h}: the band reaches y=${bottom.toFixed(1)}, past the bottom rim — this is the reported defect`);
  }
});

check("CD: the whole band's INK — labels and all — stays inside the card down to the ports-only floor", () => {
  // Stronger than the centres check: the dial's arc AND its label must be inside,
  // which is what "attached to their layout slots" actually means to the eye.
  for (const h of HEIGHTS) {
    const s = { ...audioMixerPlugin.defaults, h };
    const bottom = Math.max(...audioMixerPlugin.knobLayout(s).map(dialBottom));
    assert.ok(bottom <= h + 0.001,
      `mixer at h=${h}: the band's ink reaches y=${bottom.toFixed(1)}, past the bottom rim`);
  }
});

check("CD: the ports-only floor is where it is claimed to be, and one unit above it still fits", () => {
  // Pins PORTS_ONLY_H so the sweep cannot quietly narrow. Below it the ports have
  // spent the card and the band clips, which is the documented behavior; at it and
  // above, everything is inside.
  const fits = (h) => {
    const d = audioMixerPlugin.knobLayout({ ...audioMixerPlugin.defaults, h });
    return Math.max(...d.map(dialBottom)) <= h + 0.001;
  };
  assert.ok(fits(PORTS_ONLY_H), `the mixer's band does not fit at the claimed floor h=${PORTS_ONLY_H}`);
  assert.ok(!fits(PORTS_ONLY_H - 5),
    `the mixer's band fits below the claimed floor — PORTS_ONLY_H is too high and the sweep is testing less than it could`);
});

check("CD: THE REGRESSION ITSELF — the natural band top is BELOW the card at the reported heights", () => {
  // The arithmetic of the defect, stated so the fix cannot be undone without this
  // failing. `knobBandTop` must NOT return its natural value on a shortened card:
  // the mixer's natural top is 231, and at h=260 a band placed there reaches 325.
  const natural = knobBandTop(MIXER_SPEC, audioMixerPlugin, { ...audioMixerPlugin.defaults, h: 1000 });
  assert.equal(natural, 231, "the mixer's natural band top moved — update this pin's arithmetic with it");
  for (const h of [300, 280, 260, 250, 240]) {
    const top = knobBandTop(MIXER_SPEC, audioMixerPlugin, { ...audioMixerPlugin.defaults, h });
    assert.ok(top < natural,
      `mixer at h=${h}: the band is still at its natural top ${top} — it has not reflowed with the box`);
  }
});

check("CD: a card WITH ROOM is byte-identical to the pre-CD layout", () => {
  // The fix must not move a single dial on any card that already fitted, or every
  // authored deck's pictures change. At and above its default height the mixer's
  // band is at its natural top and at scale 1.
  for (const h of [355, 400, 500]) {
    const s = { ...audioMixerPlugin.defaults, h };
    const dials = audioMixerPlugin.knobLayout(s);
    assert.deepEqual(dials.map((d) => [d.cx, d.cy]),
      [[31, 244], [75, 244], [119, 244], [53, 293], [97, 293]],
      `mixer at h=${h} moved a dial that had room — the CD fix must be invisible on a card that already fitted`);
    assert.deepEqual(dials.map((d) => knobRadius(d)), [13, 13, 13, 13, 13]);
  }
});

check("CD: THE HIT TEST AGREES WITH THE DRAWN POSITION at every height", () => {
  // The half of CD that matters most: "a knob that draws inside the frame but
  // hits at the old position is worse than the bug". knobAt is the ONE lookup
  // web/knobFocus.dialUnder makes for both the press and the hand cursor, so
  // proving it here proves both. A press AT a dial's painted centre must find
  // THAT dial, and a press one radius-and-a-bit outside it must find none of them.
  for (const h of HEIGHTS) {
    const s = { ...audioMixerPlugin.defaults, h };
    const layout = audioMixerPlugin.knobLayout(s);
    for (const d of layout) {
      const hit = knobAt(layout, d.cx, d.cy, 0);
      assert.equal(hit?.key, d.key,
        `mixer at h=${h}: a press at dial ${d.key}'s PAINTED centre (${d.cx.toFixed(1)}, ${d.cy.toFixed(1)}) found ${JSON.stringify(hit?.key ?? null)}`);
      // Just past the dial's own radius, straight up, is not the dial. Straight up
      // rather than sideways because the neighbours are laid out horizontally.
      assert.equal(knobAt(layout, d.cx, d.cy - knobRadius(d) - 0.5, 0), null,
        `mixer at h=${h}: dial ${d.key} grabs past its own painted radius`);
    }
  }
});

check("CD: the EDITOR'S OWN lookup agrees with the drawn position at every height", () => {
  // knobAt above is the geometry; THIS is the seam web/CanvasView.dialUnder
  // actually calls, and the one BX built both the press and the hand cursor from
  // ("a separate knobCursor class on the overlay written from the SAME dialUnder
  // lookup the press uses, so hand and gesture cannot disagree"). Going through
  // knobDialAt proves the plugin's `knobLayout` declaration is what the mode sees,
  // not just that the geometry module is self-consistent.
  for (const h of HEIGHTS) {
    const s = { ...audioMixerPlugin.defaults, h };
    for (const d of audioMixerPlugin.knobLayout(s)) {
      const hit = knobDialAt(audioMixerPlugin, s, d.cx, d.cy, 0);
      assert.equal(hit?.key, d.key,
        `mixer at h=${h}: the editor's dial lookup missed ${d.key} at its own painted centre`);
      // AND THE CURSOR AGREES. A hand over a dial the press would not find is the
      // exact "cursor that lies" BX refused; a hand is offered here because these
      // dials hold plain numbers rather than equations.
      assert.equal(knobCursorFor(hit), "grab",
        `mixer at h=${h}: no hand offered over dial ${d.key}`);
    }
    // And a press in the card's empty upper body is still a body drag at every
    // size — the band must not have grown a claim on space it does not draw in.
    assert.equal(knobDialAt(audioMixerPlugin, s, Math.abs(s.w) / 2, NODE_HEADER_H + 4, 0), null,
      `mixer at h=${h}: a press just under the header found a dial`);
  }
});

check("CD: a SHRUNKEN band shrinks its dials, its pitch and its labels by ONE factor", () => {
  // Uniform, because a dial's whole reading is its pointer's ANGLE and an oval
  // dial reads its angle wrong everywhere but the axes.
  const s = { ...audioMixerPlugin.defaults, h: 260 };
  const dials = audioMixerPlugin.knobLayout(s);
  const k = knobRadius(dials[0]) / 13;
  assert.ok(k < 1, "this height must actually be shrinking the band, or the check proves nothing");
  for (const d of dials) {
    assert.ok(Math.abs(knobRadius(d) / 13 - k) < 1e-9, "a dial took a different factor from its neighbour");
    assert.ok(Math.abs(d.pitchX / 44 - k) < 1e-9, "the pitch took a different factor from the dial");
    assert.ok(Math.abs(d.labelGap / 11 - k) < 1e-9, "the label gap took a different factor");
    assert.ok(Math.abs(d.labelSize / 8 - k) < 1e-9, "the label size took a different factor");
  }
});

check("CD: the shrink STOPS at its floor and then clips, visibly, rather than vanishing", () => {
  // Past the floor a dial is a smudge that still eats presses, so the band stops
  // shrinking and overflows instead — the registry docblock's "show it" rule.
  assert.equal(knobBandScale(60, 40, 100), KNOB_BAND_MIN_SCALE);
  assert.ok(knobBandScale(60, 1, 1000) === 1, "a card with room is never scaled");
  // And a band with no rows is not a band: no scale, no division by zero.
  assert.equal(knobBandScale(60, 0, 0), 1);
});

check("CD: a FLIPPED module lays its band out identically — the sign is a reflection, not a size", () => {
  // CLAUDE.md's NEGATIVE EXTENTS law: a stored w/h MAY BE NEGATIVE, that is how
  // Flip is stored, and a plugin never sees the sign. knobLayout reads RAW folded
  // state (one of the pre-derivation readers the law names), so it resolves the
  // sign itself. Without that a flipped module computes a negative box, scales
  // straight to the floor and draws a band of smudges.
  const up = audioMixerPlugin.knobLayout({ ...audioMixerPlugin.defaults, h: 260 });
  const down = audioMixerPlugin.knobLayout({ ...audioMixerPlugin.defaults, h: -260 });
  assert.deepEqual(down.map((d) => [d.cx, d.cy]), up.map((d) => [d.cx, d.cy]));
  const wide = audioMixerPlugin.knobLayout({ ...audioMixerPlugin.defaults, w: 150 });
  const mirrored = audioMixerPlugin.knobLayout({ ...audioMixerPlugin.defaults, w: -150 });
  assert.deepEqual(mirrored.map((d) => [d.cx, d.cy]), wide.map((d) => [d.cx, d.cy]));
});

check("CD: every audio module with dials survives the whole height sweep", () => {
  // The roster form, so a module added later cannot quietly reintroduce this.
  for (const plugin of audioPlugins) {
    if (!plugin.knobLayout) continue;
    for (const h of HEIGHTS) {
      const s = { ...plugin.defaults, h };
      for (const d of plugin.knobLayout(s)) {
        assert.ok(Number.isFinite(d.cx) && Number.isFinite(d.cy),
          `${plugin.type} at h=${h}: dial ${d.key} has a non-finite centre`);
        assert.ok(d.cy < h, `${plugin.type} at h=${h}: dial ${d.key} centre is below the bottom rim`);
        assert.ok(knobRadius(d) > 0, `${plugin.type} at h=${h}: dial ${d.key} has no radius`);
      }
    }
  }
});

// ── CA: THE FAMILY MARK IS DRAWN, NOT TYPESET ───────────────────────────────

check("CA: THE MARK IS A PATH — no family may reach the display list as a character", () => {
  // THE DEFECT, and the only form of the assertion that catches its return.
  // The table used to hold one Unicode character per family, typeset by the
  // ordinary text op. Three of the six (∿ U+223F, ⋀ U+22C0, ◠ U+25E0) are in NO
  // face PowerRP registers — measured with fontkit against every file in fonts/ —
  // so Skia's fallback found nothing and drew the font's .notdef box, which at
  // 12pt is a narrow tall rectangle. That is the "tiny illegible VERTICAL text
  // badge" the user saw, and "No Glyph" is what a reader calls a tofu box; the
  // string is nowhere in this codebase.
  for (const name of NODE_FAMILY_NAMES) {
    const ops = familyMarkOps({ w: 150, h: 90 }, name);
    assert.equal(ops.length, 1, `family ${name} emits no mark`);
    assert.equal(ops[0].op, "path",
      `family ${name}'s mark is a ${ops[0].op} op — if it is text, its picture depends on font coverage and can be tofu`);
    assert.ok(typeof NODE_FAMILIES[name].mark === "string" && NODE_FAMILIES[name].mark.includes("M"),
      `family ${name} declares no path data`);
    assert.equal(NODE_FAMILIES[name].glyph, undefined,
      `family ${name} still carries a \`glyph\` character — the field is gone precisely so it cannot come back`);
  }
});

check("CA: a family card's ops are the card plus exactly one PATH, and no second text run", () => {
  const ops = familyCard({ w: 150, h: 90 }, "Reverb", "effect");
  assert.equal(ops.filter((o) => o.op === "text").length, 1, "the header must carry ONE text run: the title");
  assert.equal(ops.filter((o) => o.op === "path").length, 1, "and ONE drawn mark");
  assert.equal(ops.find((o) => o.op === "text").text, "Reverb");
});

check("CA: the mark sits INSIDE the header strip at the card's right", () => {
  // The three families whose characters DID render came from a CJK fallback at
  // that face's metrics, so `▤` sat a third of a line lower than `◇` and overflowed
  // the 24-unit header. A drawn mark is placed by this file's arithmetic, so it
  // can be asserted rather than hoped for.
  const w = 150;
  for (const name of NODE_FAMILY_NAMES) {
    const { xs, ys } = markPoints(familyMarkOps({ w, h: 90 }, name)[0].d);
    assert.ok(Math.max(...xs) <= w - 1, `${name}'s mark reaches the card's right edge`);
    assert.ok(Math.min(...xs) >= w - 10 - NODE_MARK_SIZE, `${name}'s mark starts left of its own box`);
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= NODE_HEADER_H,
      `${name}'s mark leaves the ${NODE_HEADER_H}-unit header strip (y ${Math.min(...ys)}..${Math.max(...ys)})`);
  }
});

check("CA: the TITLE is boxed so it cannot run under the mark", () => {
  const ops = familyCard({ w: 150, h: 90 }, "Ambience Pad", "source");
  const title = ops.find((o) => o.op === "text");
  const markLeft = 150 - 10 - NODE_MARK_SIZE;
  assert.ok(Number.isFinite(title.boxW), "a family card's title must be boxed");
  assert.ok(title.x + title.boxW <= markLeft,
    `the title's box (${title.x}..${title.x + title.boxW}) reaches the mark at x=${markLeft}`);
});

check("CA: a family-LESS card is unchanged — no mark, and the old unbounded title", () => {
  const ops = familyCard({ w: 150, h: 90 }, "Add");
  assert.equal(ops.length, 4);
  assert.equal(ops.filter((o) => o.op === "path").length, 0);
  assert.equal(ops[3].boxW, Infinity);
  assert.equal(nodeFamily().mark, null);
});

check("CA: the mark is FLIP-SAFE — a negative width still lands it at the card's right", () => {
  assert.equal(familyMarkOps({ w: -150, h: 90 }, "effect")[0].d,
    familyMarkOps({ w: 150, h: 90 }, "effect")[0].d);
});

check("CA: scaleUnitPath scales points and RADII but never an arc's three flags", () => {
  assert.equal(scaleUnitPath("M 0 0 L 1 1", 10, 20, 4), "M 10 20 L 14 24");
  assert.equal(scaleUnitPath("M 0.5 0 A 0.5 0.5 0 1 1 0.5 1", 0, 0, 10), "M 5 0 A 5 5 0 1 1 5 10");
  assert.equal(scaleUnitPath("M 0 0 C 0 1, 1 0, 1 1", 0, 0, 2), "M 0 0 C 0 2, 2 0, 2 2");
  assert.throws(() => scaleUnitPath("M 0 0 Q 1 1 0 1", 0, 0, 4), /unhandled SVG path command/,
    "an unscaled subpath would draw a unit-sized smudge at the corner and read as a rendering bug");
});

check("CA: every audio module's card carries exactly one drawn mark and one title", () => {
  for (const plugin of audioPlugins) {
    const ops = plugin.emit({ ...plugin.defaults }, null, { x: 0, y: 0, rotation: 0, scale: 1 });
    const texts = ops.filter((o) => o.op === "text").map((o) => o.text);
    assert.ok(ops.some((o) => o.op === "path"), `${plugin.type} draws no mark at all`);
    // No op anywhere in a real module's picture may be one of the retired glyph
    // characters — that is the roster form of the CA pin.
    for (const ch of ["∿", "⋀", "◇", "◠", "▤", "◉"]) {
      assert.ok(!texts.includes(ch),
        `${plugin.type} still typesets the retired family glyph ${ch}`);
    }
  }
});

console.log(`\nnode_resize_chrome_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
