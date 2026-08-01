/**
 * THE INK RULE (todo #253) — bare node, no framework (suite conventions:
 * core_test.js / connector_anchors_test.js).
 *
 * THE DEFECT THIS PINS, in the user's own words after shattering a Mermaid
 * flowchart: "it's just that diamonds don't have anchors in the right place."
 * Every bbox widget published the same nine anchors derived from its BOUNDING
 * BOX. That is correct for a rectangle and wrong for every other silhouette: a
 * 200x120 diamond's `tr` sat at (200, 0), outside the shape, so anything bound
 * there floated in empty space. MEASURED at the commit before the fix: 32 of the
 * 50 plugins with a hit test of their own had at least one anchor off their own
 * ink, and 19 widget types' `closest_to_rim` did too — every shapeshifter family
 * among them, because their rim was `closestPointOnRoundedRect(w, h, 0, …)`, the
 * bounding box.
 *
 * THE RULE: an anchor lands on the ink. The eight standard RIM anchors are
 * projected through the widget's OWN closest-point-on-rim map (core/derive.js
 * withInkAnchors, applied at registration); `cm` is the centre and is never
 * projected. It is a GENERALISATION of plugins/rect.js's Round 12 fix, which did
 * exactly this for one widget and stayed there for a whole round.
 *
 * WHY THESE ASSERTIONS AND NOT A TABLE OF EXPECTED POINTS. Each section states a
 * LAW over the whole registered roster and derives its own subjects from the
 * registry, so a widget added tomorrow is swept on the day it is registered:
 *   1. FIXED POINT — every rim anchor is a fixed point of its own widget's rim
 *      projection. This is what "on the rim" means, stated so it cannot be
 *      satisfied by a hardcoded coordinate.
 *   2. THE CENTRE IS NOT A RIM POINT — `cm` stays at the box centre even for a
 *      donut, whose rim does not pass through it.
 *   3. A BOX-SHAPED WIDGET IS UNCHANGED — the projection is idempotent, so this
 *      is not a migration for anyone whose silhouette already was its box.
 *   4. RECT'S ROUNDED CORNERS STILL SLIDE — the Round 12 behaviour survives the
 *      deletion of rect's private copy of it, checked against the old helper.
 *   5. THE DIAMOND — the reported bug, by coordinates.
 *   6. PLUGIN-SPECIFIC ANCHORS ARE LEFT ALONE — `light`, `staple`, `hotspot`.
 *   7. A RIM IS A PROJECTION, NOT A CLAMP — an interior query may not come back
 *      unchanged. This is the assertion that catches the defect two plugins
 *      actually had.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll, allPlugins } from "../plugins/index.js";
import {
  standardBBoxAnchors, standardRimAnchorIds, BBOX_CENTER_ANCHOR, withInkAnchors,
} from "../core/derive.js";
import { closestPointOnRoundedRect, roundedRectAnchorPoint, closestPointOnOutlines } from "../core/outline.js";
import { rectPlugin } from "../plugins/rect.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** A box with two different, non-degenerate extents, so an error that swaps or
 *  mirrors an axis cannot hide behind a square. */
const W = 200, H = 120;
/** closestAnchor takes a WORLD query and returns a LOCAL point; a query that is
 *  already local is asked through the identity world. */
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
/** Geometry tolerance in LOCAL units. The projections are closed-form, so this
 *  is float slack, not a fudge for an approximation. */
const EPS = 1e-9;

const RIM_IDS = new Set(standardRimAnchorIds());
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Every registered plugin that publishes anchors AND declares a rim — the
 *  subjects of the ink rule, derived from the registry, never listed. */
const RIM_WIDGETS = registry.all().filter((p) => p.anchors && p.closestAnchor);

test("premise: the roster has rim widgets to sweep, and the rim id set is the nine minus the centre", () => {
  assert.ok(RIM_WIDGETS.length > 20, `expected the ink rule to have many subjects, found ${RIM_WIDGETS.length}`);
  assert.deepEqual(standardRimAnchorIds(), ["tl", "tm", "tr", "ml", "mr", "bl", "bm", "br"]);
  assert.equal(RIM_IDS.size + 1, standardBBoxAnchors({ w: 1, h: 1 }).length);
  assert.ok(!RIM_IDS.has(BBOX_CENTER_ANCHOR));
});

// ── 1. FIXED POINT: every rim anchor is already on its own widget's rim ───────

test("1. every standard RIM anchor is a fixed point of its widget's own rim projection", () => {
  const bad = [];
  for (const plugin of RIM_WIDGETS) {
    const state = { ...plugin.defaults, w: W, h: H };
    for (const a of plugin.anchors(state)) {
      if (!RIM_IDS.has(a.id)) continue;
      const p = plugin.closestAnchor(state, a.x, a.y, IDENTITY_WORLD);
      if (near(a, p) > EPS) bad.push(`${plugin.type}.${a.id} (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) -> (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
  }
  assert.deepEqual(bad, [], `anchors off their own widget's rim:\n    ${bad.join("\n    ")}`);
});

// ── 2. THE CENTRE IS NOT A RIM POINT ─────────────────────────────────────────

test("2. registration moves the eight RIM anchors and NOTHING ELSE — `cm` and every plugin-specific id are untouched", () => {
  // Stated against each plugin's OWN declaration rather than against expected
  // coordinates, which is the only form that also covers a widget publishing the
  // nine over a sub-rect (tangent_lines puts them on its INK RECT, so its `cm` is
  // legitimately not the state box's centre) and every semantic anchor in the
  // roster at once.
  const bad = [];
  for (const raw of allPlugins) {
    if (!raw.anchors) continue;
    const state = { ...raw.defaults, w: W, h: H };
    const before = raw.anchors(state);
    const after = registry.get(raw.type).anchors(state);
    assert.deepEqual(after.map((a) => a.id), before.map((a) => a.id), `${raw.type}: registration changed the anchor ID SET`);
    for (let i = 0; i < before.length; i++)
      if (!RIM_IDS.has(before[i].id) && near(before[i], after[i]) > EPS)
        bad.push(`${raw.type}.${before[i].id} moved (${before[i].x}, ${before[i].y}) -> (${after[i].x}, ${after[i].y})`);
  }
  assert.deepEqual(bad, [], `registration moved a NON-rim anchor:\n    ${bad.join("\n    ")}`);
});

test("2a. `cm` is the box centre wherever the widget publishes the plain standard nine", () => {
  const bad = [];
  for (const raw of allPlugins) {
    if (raw.anchors !== standardBBoxAnchors) continue; // the widgets that publish it verbatim
    const state = { ...raw.defaults, w: W, h: H };
    const cm = registry.get(raw.type).anchors(state).find((a) => a.id === BBOX_CENTER_ANCHOR);
    if (near(cm, { x: W / 2, y: H / 2 }) > EPS) bad.push(`${raw.type} cm at (${cm.x}, ${cm.y})`);
  }
  assert.ok(bad.length === 0, `the centre was moved onto a rim:\n    ${bad.join("\n    ")}`);
});

test("2b. a hollow widget's centre is NOT on its rim — so the exemption is load-bearing, not decorative", () => {
  // A ring: the rim is two circles and the box centre lies on neither. If `cm`
  // were projected it would jump to the inner edge, and the middle of a donut is
  // exactly where a label belongs.
  const ring = registry.get("ss_radialSweep");
  const state = { ...ring.defaults, w: W, h: H, inner: 0.5, sweep: 360 };
  const centre = { x: W / 2, y: H / 2 };
  const projected = ring.closestAnchor(state, centre.x, centre.y, IDENTITY_WORLD);
  assert.ok(near(centre, projected) > 1, "premise: this widget's rim must not pass through its centre");
  assert.deepEqual(ring.anchors(state).find((a) => a.id === "cm"), { id: "cm", x: centre.x, y: centre.y });
});

// ── 3. A BOX-SHAPED WIDGET IS UNCHANGED ──────────────────────────────────────

test("3. a widget whose silhouette IS its box is byte-identical to standardBBoxAnchors", () => {
  // rect at r=0, plus every registered widget whose rim is the plain box border.
  // Stated as an equality against the shared implementation rather than against
  // nine literals, so it cannot drift from the definition it is checking.
  for (const type of ["rect", "image", "cropbox", "codeblock"]) {
    const plugin = registry.get(type);
    const state = { ...plugin.defaults, w: W, h: H, cornerRadius: 0 };
    assert.deepEqual(plugin.anchors(state), standardBBoxAnchors(state), `${type} at cornerRadius 0 must not move`);
  }
});

test("3b. the projection is IDEMPOTENT on every rim widget — applying the rule twice changes nothing", () => {
  for (const plugin of RIM_WIDGETS) {
    const state = { ...plugin.defaults, w: W, h: H };
    const once = plugin.anchors(state);
    const twice = withInkAnchors(plugin).anchors(state);
    for (let i = 0; i < once.length; i++)
      assert.ok(near(once[i], twice[i]) <= EPS, `${plugin.type}.${once[i].id} moved on a second application`);
  }
});

// ── 4. RECT'S ROUNDED CORNERS: the Round 12 behaviour survives its own deletion ─

test("4. a ROUNDED rect's corner anchors still slide onto their arcs — the general rule reproduces rect's retired override", () => {
  const R = 30;
  const state = { ...rectPlugin.defaults, w: W, h: H, cornerRadius: R };
  const got = registry.get("rect").anchors(state);
  // The expectation is computed with the helper rect.js used to call, so this
  // asserts EQUIVALENCE with the deleted code rather than restating its output.
  for (const a of standardBBoxAnchors(state)) {
    const want = roundedRectAnchorPoint(W, H, R, a.id, a.x, a.y);
    const mine = got.find((g) => g.id === a.id);
    assert.ok(near(mine, want) <= EPS, `rect r=${R} anchor ${a.id}: got (${mine.x}, ${mine.y}), the retired override gave (${want.x}, ${want.y})`);
  }
  // And it really did move: a corner is not where the bounding box says.
  const tr = got.find((g) => g.id === "tr");
  assert.ok(near(tr, { x: W, y: 0 }) > 1, "premise: a 30px corner radius must actually move `tr`");
});

// ── 5. THE DIAMOND — the reported bug, by coordinates ────────────────────────

/** A 200x120 diamond: `polygonStar` with four points and no inner dent. Its ink
 *  is the quadrilateral (100,0) (200,60) (100,120) (0,60), so the four bbox
 *  CORNERS are empty space. */
const diamondState = () => ({ ...registry.get("ss_polygonStar").defaults, w: W, h: H, points: 4, innerRatio: 1, startAngle: 0, cornerRadius: 0 });
const DIAMOND_OUTLINE = [[[100, 0], [200, 60], [100, 120], [0, 60]]];

test("5. a diamond's rim anchors are ON the diamond, and `tr` is no longer the empty bbox corner", () => {
  const plugin = registry.get("ss_polygonStar");
  const state = diamondState();
  // Premise: the widget really does draw the quadrilateral this section assumes.
  const drawn = plugin.hitTest(state, W / 2, H / 2, 0);
  assert.equal(drawn, true, "premise: the diamond has interior ink");
  for (const a of plugin.anchors(state)) {
    if (!RIM_IDS.has(a.id)) continue;
    const onOutline = closestPointOnOutlines(DIAMOND_OUTLINE, a.x, a.y, { x: NaN, y: NaN });
    assert.ok(near(a, onOutline) <= 1e-6, `diamond anchor ${a.id} at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) is not on the diamond`);
  }
  const tr = plugin.anchors(state).find((a) => a.id === "tr");
  assert.ok(near(tr, { x: W, y: 0 }) > 1, "the reported bug: `tr` sat at the empty bbox corner (200, 0)");
});

test("5b. a diamond's rim solve — what the shattered Mermaid edge uses — meets the ink, not the corner", () => {
  const plugin = registry.get("ss_polygonStar");
  const state = diamondState();
  // The user's case: a neighbour far to the RIGHT and slightly ABOVE. The bbox
  // rim answered (200, 0), a corner of empty space.
  const p = plugin.closestAnchor(state, 1000, 0, IDENTITY_WORLD);
  assert.ok(near(p, { x: W, y: 0 }) > 1, "the rim still answers with the empty bbox corner");
  assert.ok(near(p, closestPointOnOutlines(DIAMOND_OUTLINE, p.x, p.y, { x: NaN, y: NaN })) <= 1e-6, "the rim answer is not on the diamond");
});

// ── 6. PLUGIN-SPECIFIC ANCHORS ARE LEFT ALONE ────────────────────────────────

test("6. an anchor a plugin placed itself is never projected — the plugin meant it there", () => {
  // Each of these is a SEMANTIC anchor: a point that matters for what the widget
  // IS, not for where its edge is. The lens flare's is the light itself, which is
  // usually nowhere near the rim.
  for (const [type, id] of [["demo_lens_flare", "light"], ["demo_god_rays", "light"], ["cursor", "hotspot"], ["pdf_packet", "staple"], ["anchor_point", "pt"]]) {
    const plugin = registry.get(type);
    const state = { ...plugin.defaults, w: W, h: H };
    const wrapped = plugin.anchors(state).find((a) => a.id === id);
    assert.ok(wrapped, `${type} must still publish "${id}"`);
    const raw = withInkAnchors({ ...plugin, closestAnchor: () => ({ x: -999, y: -999 }) }).anchors(state).find((a) => a.id === id);
    assert.deepEqual(raw, wrapped, `${type}.${id} was moved by the rim projection`);
  }
});

// ── 7. A RIM IS A PROJECTION, NOT A CLAMP ────────────────────────────────────

test("7. no widget's rim returns an INTERIOR query unchanged — a clamp is not a projection", () => {
  // The defect this catches, twice over in the roster before this file existed:
  // `{x: clamp(0, w, qx), y: clamp(0, h, qy)}` looks like "project onto the box"
  // and is not — every query already inside the box is its own answer, so
  // closest_to_rim against an overlapping widget landed INSIDE it.
  const bad = [];
  for (const plugin of RIM_WIDGETS) {
    const state = { ...plugin.defaults, w: W, h: H };
    const q = { x: W / 2, y: H / 2 };
    const p = plugin.closestAnchor(state, q.x, q.y, IDENTITY_WORLD);
    if (near(p, q) <= EPS) bad.push(plugin.type);
  }
  assert.deepEqual(bad, [], `these rims answered an interior query with the query itself:\n    ${bad.join("\n    ")}`);
});

// ── 8. THE SEAM IS WIRED ─────────────────────────────────────────────────────

test("8. the rule is applied by the REGISTRY, so a plugin gets it without declaring anything", () => {
  // A brand-new plugin, never edited for this feature, registered like any other.
  // If the wrap is ever removed from createRegistry.register, this fails while
  // every hand-written plugin above might still pass on its own merits.
  const INSET = 10;
  const reg = createRegistry();
  reg.register({
    type: "w4l_probe", title: "Probe", capabilities: { bbox: true }, defaults: { w: W, h: H },
    emit: () => [],
    anchors: standardBBoxAnchors,
    // A rim that is the box INSET by 10 on every side: nothing like the bbox, so
    // the projection has to actually happen for the assertion below to hold.
    closestAnchor: (s, x, y) => {
      const p = closestPointOnRoundedRect((s.w ?? 0) - 2 * INSET, (s.h ?? 0) - 2 * INSET, 0, x - INSET, y - INSET);
      return { x: p.x + INSET, y: p.y + INSET };
    },
  });
  const tl = reg.get("w4l_probe").anchors({ w: W, h: H }).find((a) => a.id === "tl");
  assert.deepEqual(tl, { id: "tl", x: INSET, y: INSET }, "the registry did not apply the ink rule to a freshly registered plugin");
  const cm = reg.get("w4l_probe").anchors({ w: W, h: H }).find((a) => a.id === "cm");
  assert.deepEqual(cm, { id: "cm", x: W / 2, y: H / 2 }, "the registry projected the centre");
});

console.log(`\nanchor_ink_test: ${passed} passed`);
