/**
 * NODE CHROME CONTAINMENT (R7-10) — the invariant, swept.
 * Run: node src/demo_apps/PowerRP/tests/node_chrome_layout_test.js
 *
 * ── THE USER'S COMPLAINT, WHICH IS A CONTAINMENT CLAIM ──────────────────────
 * "Nodes don't seem to have any coherent way of where you place the knobs.
 * Axelotti does investigate that. Because right now, where the knobs go is kind
 * of haphazard. There's no guarantee the knobs will even be in the node."
 *
 * "No guarantee" is the operative phrase: there was no assertion anywhere in the
 * suite that a node's own content lies inside its own card. tests/node_resize_
 * chrome_test.js sweeps the AUDIO family's dial centres, which is why the audio
 * family got workstream CD's reflow and the CONTROL family never did — nothing
 * was watching it. This file is the missing guarantee, over EVERY registered node
 * type, at many sizes, in both signs.
 *
 * ── WHY IT TESTS CONTAINMENT AND NOT VISIBILITY ─────────────────────────────
 * `.frenzy/round7/patchers_blueprints_report.md` §(a) traced what an unchecked
 * control actually does in VCV Rack, where `ModuleWidget::addParam()` is
 * `addChild(param)` with no bounds check: `drawChild` clips an out-of-panel
 * widget so it is NEVER DRAWN, and `recurseEvent` skips it so it RECEIVES NO
 * MOUSE EVENTS — yet the param still serializes, randomizes, is MIDI-mappable
 * and is read every sample. An invisible, unreachable, LIVE control. That is
 * strictly worse than a knob sticking out of the box, because there is nothing
 * to notice. So the assertion is that the control's BOX is inside the card, never
 * that it happens to be visible.
 *
 * ── WHAT IS SWEPT, AND WHY THE FLOOR IS DERIVED ─────────────────────────────
 * Every height from the plugin's own default DOWN TO its declared floor — the
 * height at which the reflow ladder bottoms out and the registry docblock's rule
 * takes over ("SHOW the overflow so the author can see the node is too small").
 * A sweep that asserted containment BELOW that floor would be asserting the
 * content away, which is the mistake tests/node_resize_chrome_test.js records
 * itself making from the other direction. The floor is DERIVED per plugin rather
 * than listed, so a widget added tomorrow is swept without editing this file.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { portLayout, portsOnlyFloorHeight, PORT_BEAD_R } from "../core/nodeflow.js";
import { unsignedState } from "../core/geometry.js";
import {
  NODE_HEADER_H, nodeBodyTop, nodeBox, nodeFaceBand, portIsWired, textLineH, titleLineTop,
} from "../core/node_chrome.js";
import { knobRadius, KNOB_BAND_MIN_SCALE } from "../core/node_knobs.js";
import { paramShowsWidget } from "../core/audio_nodes.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

/** EVERY node widget, derived from the registry — never listed, so a widget added
 *  tomorrow is swept by all of this without touching this file. */
const NODES = registry.all().filter((p) => p.audioModule || p.controlNode || /^node_/.test(p.type));

/**
 * Pure function. The INK BOX of one display-list op, in the node's LOCAL frame —
 * conservatively, so a miss is a false RED rather than a false green.
 *
 * A text op's box is its `y` down one LINE (its `y` is the line box's top —
 * core/node_chrome.textLineH) and its `boxW` across, which is exactly the box the
 * renderer lays the paragraph into. An unbounded `boxW` (Infinity) reports only
 * its origin, because how wide an unwrapped run runs is a font question that bare
 * node cannot answer — that is stated as a known bound rather than guessed at.
 *
 * @param {object} op - a display-list command
 * @returns {{x0: number, y0: number, x1: number, y1: number}|null} null = not ink
 *
 * @example opInkBox({op: "rect", x: 4, y: 6, w: 10, h: 20}) // {x0: 4, y0: 6, x1: 14, y1: 26}
 * @example opInkBox({op: "ellipse", cx: 10, cy: 10, rx: 3, ry: 4}) // {x0: 7, y0: 6, x1: 13, y1: 14}
 * @example // a boxed text run occupies its box, one line tall
 * @example opInkBox({op: "text", x: 0, y: 10, size: 10, boxW: 50}) // {x0: 0, y0: 10, x1: 50, y1: 22}
 * @example opInkBox({op: "path", d: "M 0 0 L 5 9"}) // {x0: 0, y0: 0, x1: 5, y1: 9}
 */
export function opInkBox(op) {
  if (op.op === "rect") return { x0: op.x, y0: op.y, x1: op.x + op.w, y1: op.y + op.h };
  if (op.op === "ellipse") return { x0: op.cx - op.rx, y0: op.cy - op.ry, x1: op.cx + op.rx, y1: op.cy + op.ry };
  if (op.op === "text") {
    const w = Number.isFinite(op.boxW) ? op.boxW : 0;
    return { x0: op.x, y0: op.y, x1: op.x + w, y1: op.y + textLineH(op.size) };
  }
  if (op.op === "path") {
    const pts = pathPoints(op.d);
    if (!pts.xs.length) return null;
    return { x0: Math.min(...pts.xs), y0: Math.min(...pts.ys), x1: Math.max(...pts.xs), y1: Math.max(...pts.ys) };
  }
  return null;
}

/**
 * Pure function. The ENDPOINTS an SVG path visits, as {xs, ys}.
 *
 * Parsed per command rather than by pairing every number in the string, because
 * an arc's `rx ry rot largeArc sweep x y` has SEVEN numbers of which only the
 * last two are a point. tests/node_resize_chrome_test.js records what blanket
 * pairing costs: it read `rot largeArc` as a coordinate and reported the ring
 * mark as leaving the header by 111 units, which is a bug in the check.
 *
 * @param {string} d - an SVG path
 * @returns {{xs: number[], ys: number[]}}
 *
 * @example pathPoints("M 0 0 L 5 9") // {xs: [0, 5], ys: [0, 9]}
 * @example pathPoints("M 5 0 A 5 5 0 1 1 5 10").xs // [5, 5]
 */
export function pathPoints(d) {
  const t = String(d).trim().split(/[\s,]+/).filter(Boolean);
  const xs = [], ys = [];
  let i = 0;
  const point = () => { xs.push(Number(t[i++])); ys.push(Number(t[i++])); };
  while (i < t.length) {
    const cmd = t[i++];
    if (cmd === "M" || cmd === "L") point();
    else if (cmd === "C") { point(); point(); point(); }
    else if (cmd === "A") { i += 5; point(); }
    else if (cmd === "Z") continue;
    else throw new Error(`pathPoints: unhandled command ${cmd} in ${d}`);
  }
  return { xs, ys };
}

/**
 * Query. The heights a plugin is swept at: its own default down to its derived
 * floor, plus a couple above it.
 *
 * The floor is the LOWER of what the port column needs and what the face's own
 * ladder bottoms out at, because either can be the binding constraint and this
 * sweep must not claim containment below whichever it is.
 */
function sweepHeights(plugin, w) {
  const d = { ...plugin.defaults, w };
  const floor = Math.ceil(Math.max(portsOnlyFloorHeight(plugin, d), nodeFloorOf(plugin, d)));
  const top = Math.max(floor, Math.round(plugin.defaults.h ?? 120));
  const out = new Set([top, Math.round(top * 1.5), Math.round(top * 2)]);
  for (let h = top; h >= floor; h -= Math.max(4, Math.round((top - floor) / 9 || 4))) out.add(Math.round(h));
  out.add(floor);
  return [...out].filter((h) => h > 0).sort((a, b) => b - a);
}

/**
 * Query. A widget's DECLARED FLOOR at a given width, asked of the widget itself.
 *
 * ── IT IS A FUNCTION OF WIDTH, AND FINDING THAT OUT IS WHY THIS SWEEP EXISTS ─
 * The first version of this file computed a floor from each plugin's DEFAULT
 * state and swept heights against it at every width. That is wrong for any node
 * whose band WRAPS: an oscillator is a one-row band at 150 wide and a THREE-row
 * band at 80, so its true floor at 80 is 98 units higher. The sweep duly found
 * `audio_oscillator at 80x124: dial level spans y 124.7..133.3 outside the card`
 * — a real escape at a real size, produced by asking the wrong question about
 * the floor rather than by any fault in the ladder.
 *
 * The trio (number/math/display) declare no floor: their headline value is a
 * CENTRED band that shrinks with the card and cannot overflow above the port
 * column's own floor, so `portsOnlyFloorHeight` is the honest answer for them.
 */
function nodeFloorOf(plugin, state) {
  return plugin.nodeFloorHeight?.(state) ?? portsOnlyFloorHeight(plugin, state);
}

/** THE WIDTHS. A node is resizable in both axes and the wrap depends on width. */
const WIDTHS = [400, 220, 150, 110, 80];

/** Slack allowed on a containment claim, in LOCAL units. Not zero, and the reason
 *  is honest: a bead deliberately STRADDLES the card's edge (half in, half out —
 *  the Audulus look, core/nodeflow.portLayout), and the rim is a 1.5-unit stroke
 *  centred on the boundary. So the box every control must lie in is the card
 *  grown by one bead radius, which is exactly `nodeInkBounds`' own definition of
 *  a node's ink. Anything past THAT is an escape. */
const EDGE_SLACK = PORT_BEAD_R;

console.log("node chrome: the containment invariant");

check("EVERY node type's own content lies inside its card, at every size", () => {
  for (const plugin of NODES) {
    for (const w of WIDTHS) {
      for (const h of sweepHeights(plugin)) {
        // THROUGH `unsignedState`, WHICH IS WHAT emit() ACTUALLY RECEIVES.
        // core/derive.js:560 applies it to every node before deriving, so a raw
        // NEGATIVE extent never reaches a painter — "plugins NEVER see it"
        // (CLAUDE.md's NEGATIVE EXTENTS law). Feeding emit a signed box here would
        // test a state the pipeline cannot produce and would red on
        // core/nodeflow.portLayout, which is correct as it stands. The flip is
        // covered as its own law by the next check, against the RAW-state readers
        // that genuinely do meet a sign.
        const s = unsignedState({ ...plugin.defaults, w, h });
        const box = nodeBox(s);
        const ops = plugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 });
        for (const op of ops) {
          const ink = opInkBox(op);
          if (!ink) continue;
          const escapes = ink.x0 < -EDGE_SLACK || ink.y0 < -EDGE_SLACK
            || ink.x1 > box.w + EDGE_SLACK || ink.y1 > (box.h ?? 0) + EDGE_SLACK;
          assert.ok(!escapes,
            `${plugin.type} at ${w}x${h}: a ${op.op} op reaches `
            + `(${ink.x0.toFixed(1)}, ${ink.y0.toFixed(1)})..(${ink.x1.toFixed(1)}, ${ink.y1.toFixed(1)}) `
            + `outside a ${box.w}x${box.h} card${op.text ? ` — text ${JSON.stringify(op.text)}` : ""}`);
        }
      }
    }
  }
});

check("A FLIP IS A REFLECTION, NOT A SIZE — every RAW-state reader resolves the sign", () => {
  // The other half of the NEGATIVE EXTENTS law, and the half that was broken:
  // `knobLayout` and `controlFace` are called by web/knobFocus.js on RAW item
  // state, not on a derived node, so they meet a signed box and must unsign it
  // themselves. plugins/node_knob.js did not (`cx: (s?.w ?? DEFAULT_W) / 2`), so a
  // flipped Knob hit-tested its dial at negative x; the slider's track and the
  // button's face had the same arithmetic.
  for (const plugin of NODES) {
    const base = { ...plugin.defaults };
    const flipped = { ...base, w: -Math.abs(base.w ?? 150), h: -Math.abs(base.h ?? 120) };
    if (plugin.knobLayout) {
      assert.deepEqual(
        plugin.knobLayout(flipped).map((k) => [k.cx, k.cy, knobRadius(k)]),
        plugin.knobLayout(base).map((k) => [k.cx, k.cy, knobRadius(k)]),
        `${plugin.type}'s dials move when the card is flipped — the sign is a reflection, not a size`);
    }
    if (plugin.controlFace) {
      assert.deepEqual(plugin.controlFace(flipped), plugin.controlFace(base),
        `${plugin.type}'s face moves when the card is flipped`);
    }
  }
});

check("EVERY dial a node declares is inside its card, and grabbable where it is drawn", () => {
  // The knobLayout half: the picture is checked above, but the HIT TEST reads the
  // same records and a dial that draws inside while hitting outside is the defect
  // that is invisible in a screenshot.
  for (const plugin of NODES) {
    if (!plugin.knobLayout) continue;
    for (const w of WIDTHS) {
      for (const h of sweepHeights(plugin)) {
        const s = { ...plugin.defaults, w, h };
        for (const k of plugin.knobLayout(s)) {
          const r = knobRadius(k);
          assert.ok(Number.isFinite(k.cx) && Number.isFinite(k.cy),
            `${plugin.type} at ${w}x${h}: dial ${k.key} has a non-finite centre`);
          assert.ok(k.cy - r >= -EDGE_SLACK && k.cy + r <= h + EDGE_SLACK,
            `${plugin.type} at ${w}x${h}: dial ${k.key} spans y ${(k.cy - r).toFixed(1)}..${(k.cy + r).toFixed(1)} outside the card`);
          assert.ok(k.cx - r >= -EDGE_SLACK && k.cx + r <= w + EDGE_SLACK,
            `${plugin.type} at ${w}x${h}: dial ${k.key} spans x ${(k.cx - r).toFixed(1)}..${(k.cx + r).toFixed(1)} outside the card`);
          assert.ok(r > 0, `${plugin.type} at ${w}x${h}: dial ${k.key} has no radius`);
        }
      }
    }
  }
});

check("A CONTROL NEVER HAS AN AUTHORED x — every face is derived from the box", () => {
  // The survey's one unbreakable rule: "The moment a control carries an authored
  // coordinate, you have VCV Rack." Checked structurally — a face's x/w must be a
  // pure function of the card's width, so widening the card by N moves the face's
  // right edge and NOTHING else can pin it.
  for (const plugin of NODES) {
    if (!plugin.controlFace) continue;
    const a = plugin.controlFace({ ...plugin.defaults, w: 200 });
    const b = plugin.controlFace({ ...plugin.defaults, w: 300 });
    assert.equal(a.x, b.x, `${plugin.type}'s face x must be a margin, not a coordinate`);
    assert.equal(b.w - a.w, 100, `${plugin.type}'s face width must follow the card's`);
  }
});

check("THE ONE LAYOUT PATH IS UNBYPASSABLE — no control node may hand-place its face", () => {
  // Bespoke Synth is the measured cautionary tale: an excellent auto-layout macro
  // that only 83 of ~265 modules use, because 191 headers override the sizing
  // hook. An auto-layout that can be opted out of WILL be. So the factory does not
  // offer an override, exactly as core/audio_nodes.js:305-312 withholds one for
  // `emit`/`ports` — and this is the assertion that keeps it withheld.
  for (const plugin of NODES) {
    if (!plugin.controlNode) continue;
    assert.equal(typeof plugin.controlFace, "function",
      `${plugin.type} is a control node with no derived face — it is placing its own control`);
  }
});

console.log("node chrome: the stack itself");

check("nodeFaceBand keeps a band inside the box at every height above its floor", () => {
  // The ladder, stated as its own property rather than through a widget: for any
  // declaration, top + height <= boxH as long as the band fits at its minimum.
  for (const height of [10, 26, 52, 94]) {
    for (const floorTop of [24, 38, 70]) {
      for (const boxH of [400, 200, 140, 120, 100]) {
        const band = nodeFaceBand({ floorTop, top: floorTop + 20, height }, boxH);
        if (floorTop + height * (1 / 3) > boxH) continue; // below the floor: clipping is the contract
        assert.ok(band.top + band.height <= boxH + 1e-9,
          `a ${height}-tall band from ${floorTop} in a ${boxH} box reached ${band.top + band.height}`);
        assert.ok(band.top >= floorTop - 1e-9, "a band must never climb above its own floor");
      }
    }
  }
});

check("a node's TITLE stays inside its header strip", () => {
  // It did not: `NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3` reads as a baseline and
  // a text op's y is the line box's TOP, so every card in the app drew its name
  // hanging below its own header.
  assert.ok(titleLineTop() >= 0, "a title must not start above the card");
  assert.ok(titleLineTop() + textLineH(12) <= NODE_HEADER_H + 1e-9,
    "a title's line must end inside the header strip");
});

check("nodeBodyTop follows the PORT COLUMN, including when the column reflows", () => {
  // The one-source rule. A face placed from a remembered port height drifts under
  // a reflowed bead on exactly the short cards this workstream is about.
  const p = { ports: () => ({ inputs: [{ key: "a", type: "number" }, { key: "b", type: "number" }] }) };
  const tall = nodeBodyTop(p, { w: 150, h: 300 });
  const short = nodeBodyTop(p, { w: 150, h: 80 });
  assert.ok(short < tall, "a reflowed column must pull the body top up with it");
  const rows = portLayout(p, { w: 150, h: 80 });
  assert.equal(short, Math.max(...rows.map((r) => r.y)) + PORT_BEAD_R + 8,
    "the body top must be the LAST bead's own bottom, plus one gap");
});

console.log("node chrome: the knob-or-input duality");

check("a WIRED param stops drawing a dial, and an unwired one keeps it", () => {
  // The predicate Blender, Blueprint, Rete and litegraph each invented separately.
  const filter = registry.get("audio_filter");
  const free = filter.knobLayout({ ...filter.defaults });
  assert.ok(free.some((k) => k.key === "frequency"), "an unwired cutoff is a dial");
  const driven = filter.knobLayout({
    ...filter.defaults, inputs: { frequency: { item: "lfo1", port: "out" } },
  });
  assert.ok(!driven.some((k) => k.key === "frequency"),
    "a cutoff a wire is driving must not still be a turnable dial showing its own number");
  assert.ok(driven.some((k) => k.key === "Q"), "the OTHER params are none of that wire's business");
  // And the band gets shorter, which is the visible half — Blender's node
  // "visibly shrinks the instant a link attaches".
  assert.ok(driven.length === free.length - 1);
});

check("the DUALITY reads off the ONE connection map, and a dead slot is not a wire", () => {
  assert.equal(portIsWired({ inputs: { in: { item: "n1", port: "out" } } }, "in"), true);
  assert.equal(portIsWired({ inputs: { in: null } }, "in"), false);
  assert.equal(portIsWired({}, "in"), false);
  // A param with NO same-named socket can never be driven, so it is always a knob.
  assert.equal(paramShowsWidget({ inputs: [], knobs: [{ key: "q" }] }, { inputs: { q: { item: "x", port: "out" } } }, "q"), true);
});

check("a CONNECTED input bead is filled, and an unconnected one is not", () => {
  // Axoloti's jack rule, and the only "this is driven" indicator in that whole app.
  const filter = registry.get("audio_filter");
  const wired = filter.emit({ ...filter.defaults, inputs: { in: { item: "o1", port: "out" } } }, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  const free = filter.emit({ ...filter.defaults }, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  const cores = (ops) => ops.filter((o) => o.op === "ellipse").filter((_, i) => i % 2 === 1);
  const different = cores(wired).some((o, i) => JSON.stringify(o.fill) !== JSON.stringify(cores(free)[i]));
  assert.ok(different, "a wired socket must look different from an open one");
});

console.log(`\nnode_chrome_layout_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
