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
import { readFileSync } from "node:fs";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { newDocument, withNewItem, foldState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { registerAll, allPlugins } from "../plugins/index.js";
import {
  standardBBoxAnchors, standardRimAnchorIds, BBOX_CENTER_ANCHOR, withInkAnchors,
} from "../core/derive.js";
import { closestPointOnRoundedRect, closestPointOnOutlines, pathDPolylines } from "../core/outline.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
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

test("4. a ROUNDED rect's corner anchors still slide onto their arcs — the Round 12 behaviour, now delivered by the general rule", () => {
  // THIS SECTION CARRIES A DELETED TEST. `roundedRectAnchorPoint` was rect's (and
  // cropbox's, and codeblock's) private way of doing this and had no consumer left
  // once the ink rule landed, so it and its block in tests/outline_test.js are
  // gone. Its assertions are restated here against GEOMETRY rather than against
  // the retired helper's output — which is the stronger form anyway: a corner
  // anchor is ON the rounded rim, and is pulled in from the square corner by
  // exactly r·(√2−1), the 45° arc point.
  const R = 30;
  const state = { ...rectPlugin.defaults, w: W, h: H, cornerRadius: R };
  const got = registry.get("rect").anchors(state);
  const CORNERS = { tl: { x: 0, y: 0 }, tr: { x: W, y: 0 }, bl: { x: 0, y: H }, br: { x: W, y: H } };
  for (const [id, square] of Object.entries(CORNERS)) {
    const a = got.find((g) => g.id === id);
    assert.ok(near(a, closestPointOnRoundedRect(W, H, R, a.x, a.y)) <= EPS, `rect r=${R} anchor ${id} is not ON the rounded rim`);
    assert.ok(Math.abs(near(a, square) - R * (Math.SQRT2 - 1)) <= 1e-9, `rect r=${R} anchor ${id} is not the 45° arc point (should be r·(√2−1) in from the square corner)`);
  }
  // Edge midpoints and the centre are on straight edges / the interior, so
  // rounding must not move them at all.
  for (const id of ["tm", "mr", "bm", "ml", "cm"])
    assert.deepEqual(got.find((g) => g.id === id), standardBBoxAnchors(state).find((g) => g.id === id), `rounding moved ${id}`);
  // r = 0 is the square rect verbatim — the no-rounding case, unaffected.
  assert.deepEqual(registry.get("rect").anchors({ ...state, cornerRadius: 0 }), standardBBoxAnchors(state));
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
    type: "w4l_probe", ephemeral: "none", title: "Probe", capabilities: { bbox: true }, defaults: { w: W, h: H },
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

// ── 9. THE SVG WIDGET — the user's LITERAL case ──────────────────────────────

/** The rhombus a shattered Mermaid node becomes: `plugins/mermaid.js` emits a
 *  `type: "svg"` part carrying that node's own paths, and binds every anchored
 *  edge with `@<key>_closest`. So this IS the widget from the bug report. */
const RHOMBUS_SVG = `<svg viewBox="0 0 ${W} ${H}"><path d="M${W / 2} 0L${W} ${H / 2}L${W / 2} ${H}L0 ${H / 2}Z" fill="#eeeeee" stroke="#333333"/></svg>`;
/** Is a box-local point inside that rhombus? |x-w/2|/(w/2) + |y-h/2|/(h/2) <= 1. */
const inRhombus = (p) => Math.abs(p.x - W / 2) / (W / 2) + Math.abs(p.y - H / 2) / (H / 2) <= 1 + 1e-6;

test("9. an svg widget's rim follows its ARTWORK — a shattered Mermaid diamond meets its edge, not its bbox corner", () => {
  const svg = registry.get("svg");
  const state = { ...svg.defaults, w: W, h: H, svgSrc: RHOMBUS_SVG, preserveAspect: false };
  // THE REPORTED BUG, by coordinates: a neighbour far RIGHT and ABOVE used to be
  // answered with (200, 0) — a corner of empty space outside the diamond.
  const p = svg.closestAnchor(state, 1000, 0, IDENTITY_WORLD);
  assert.ok(inRhombus(p), `the rim answered (${p.x}, ${p.y}), which is not on the diamond`);
  assert.ok(near(p, { x: W, y: 0 }) > 1, "the rim still answers with the empty bbox corner");
  // And every rim ANCHOR follows, through the ink rule, with no svg-side code.
  for (const a of svg.anchors(state))
    if (RIM_IDS.has(a.id)) assert.ok(inRhombus(a), `svg anchor ${a.id} at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) is off the artwork`);
});

test("9b. preserveAspect LETTERBOXES the artwork, and the rim goes with it", () => {
  // The flatten wraps the art in one pushTransform when aspect is preserved. If
  // that frame were dropped, the rim would sit at the un-letterboxed coordinates
  // — right shape, wrong place, and nothing else would notice.
  const svg = registry.get("svg");
  const square = `<svg viewBox="0 0 100 100"><path d="M50 0L100 50L50 100L0 50Z" fill="#eeeeee"/></svg>`;
  const state = { ...svg.defaults, w: W, h: H, svgSrc: square, preserveAspect: true };
  // A 100x100 viewBox in a 200x120 box fits to 120x120, centred: x from 40 to 160.
  const p = svg.closestAnchor(state, 1000, H / 2, IDENTITY_WORLD);
  assert.ok(Math.abs(p.x - 160) < 1e-6 && Math.abs(p.y - H / 2) < 1e-6, `letterboxed right vertex should be (160, 60), got (${p.x}, ${p.y})`);
});

test("9c. a widget with NO artwork falls back to the box border — the states that really do draw a box", () => {
  const svg = registry.get("svg");
  const box = { x: 0, y: 0, w: W, h: H };
  for (const [why, extra] of [
    ["an empty source (a ghost)", { svgSrc: "" }],
    ["a source that will not parse (draws the red error BOX)", { svgSrc: "<svg><path d=" }],
    ["a url with nothing behind it yet", { svgSource: "url", svgUrl: "/asset/Nope/missing.svg" }],
  ]) {
    const p = svg.closestAnchor({ ...svg.defaults, w: W, h: H, ...extra }, 1000, 0, IDENTITY_WORLD);
    assert.deepEqual(p, closestPointOnRectBorder(box, 1000, 0), `${why}: should answer with the box border`);
  }
});

test("9d. the svg rim's one-entry cache cannot return another widget's geometry", () => {
  // The cache is keyed by value and holds one entry, so interleaving two widgets
  // must give each its own answer every time. A cache that returned the previous
  // widget's outline would be a SILENT wrong picture, which is the worst failure
  // this file could miss.
  const svg = registry.get("svg");
  const a = { ...svg.defaults, w: W, h: H, svgSrc: RHOMBUS_SVG, preserveAspect: false };
  const b = { ...svg.defaults, w: W, h: H, svgSrc: `<svg viewBox="0 0 ${W} ${H}"><path d="M0 0L${W} 0L${W} ${H}L0 ${H}Z" fill="#eeeeee"/></svg>`, preserveAspect: false };
  const soloA = svg.closestAnchor(a, 1000, 0, IDENTITY_WORLD);
  const soloB = svg.closestAnchor(b, 1000, 0, IDENTITY_WORLD);
  assert.ok(near(soloA, soloB) > 1, "premise: the two sources must disagree, or this proves nothing");
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(svg.closestAnchor(a, 1000, 0, IDENTITY_WORLD), soloA, "interleaving changed A's rim");
    assert.deepEqual(svg.closestAnchor(b, 1000, 0, IDENTITY_WORLD), soloB, "interleaving changed B's rim");
  }
});

// ── 10. pathDPolylines — the sampler the svg rim is built on ─────────────────

test("10. pathDPolylines samples the five-command normal form, and arcs arrive as cubics", () => {
  assert.deepEqual(pathDPolylines("M0 0L10 0L10 10Z"), [[[0, 0], [10, 0], [10, 10]]]);
  assert.equal(pathDPolylines("M0 0L10 0M20 20L30 20").length, 2, "two subpaths");
  // Relative and shorthand commands are resolved by transformPathD before this
  // function sees them — which is the whole reason it is not a second parser.
  assert.deepEqual(pathDPolylines("M0 0h10v10", 2), [[[0, 0], [10, 0], [10, 10]]]);
  // An arc is converted to cubics upstream, so it arrives as sampled curve points
  // rather than throwing on an unknown command.
  assert.ok(pathDPolylines("M0 0A50 50 0 0 1 100 0", 2)[0].length > 2, "the arc produced curve samples");
  // A sampled curve really follows the curve: the quadratic's midpoint.
  assert.deepEqual(pathDPolylines("M0 0Q50 100 100 0", 2)[0][1], [50, 50]);
});

test("10b. a sampled rhombus is the rhombus — the sampler feeds closestPointOnOutlines correctly", () => {
  const subpaths = pathDPolylines(`M${W / 2} 0L${W} ${H / 2}L${W / 2} ${H}L0 ${H / 2}Z`);
  const p = closestPointOnOutlines(subpaths, W, 0, { x: NaN, y: NaN });
  assert.ok(inRhombus(p), `sampled rhombus answered (${p.x}, ${p.y})`);
  assert.deepEqual(subpaths, [[[100, 0], [200, 60], [100, 120], [0, 60]]], "no spurious points, no dropped closing leg");
});

// ── 11. LAYOUT READS THE BOX; ATTACHMENT READS THE INK ───────────────────────

test("11. a shattered node's LABEL is bound to the stored box, not to corner anchors", () => {
  // THE REGRESSION THIS PINS IS ONE THE INK RULE ITSELF CREATED. plugins/mermaid.js
  // used to reconstruct a node's box from `@key_tl` / `@key_tr` / `@key_bl` — an
  // exact reading only while every anchor sat on the bounding rectangle. Once rim
  // anchors moved onto the SILHOUETTE, a diamond node's label would have been
  // offset from a point on its upper-left EDGE and sized to the gap between two
  // inset edges: shifted and shrunk, on the very shape that motivated the change.
  //
  // The division the fix encodes, and the reason this test exists rather than a
  // comment: read `@id.x/.y/.w/.h` to lay something out against a BOX; read
  // `@id_tl` to attach something to INK.
  const src = readFileSync(new URL("../plugins/mermaid.js", import.meta.url), "utf8");
  const label = src.slice(src.indexOf("AN OFFSET FROM THE BOX'S TOP-LEFT"), src.indexOf("}, toWorld, map) });", src.indexOf("AN OFFSET FROM THE BOX'S TOP-LEFT")));
  assert.ok(label.length > 0, "premise: the label-binding block must be findable");
  const code = label.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const anchorRef of ["_tl.x", "_tl.y", "_tr.x", "_bl.y"])
    assert.ok(!code.includes(anchorRef), `the label binding still reads the corner anchor "${anchorRef}" — under the ink rule that is not the box`);
  for (const boxRef of [")}.x", ")}.y", ")}.w", ")}.h"])
    assert.ok(code.includes(boxRef), `the label binding should read the stored box "${boxRef}"`);
});

test("11b. the stored box IS equation-readable, which is what makes 11 possible", () => {
  // If `@id.w` did not resolve, the fix above would be a silent breakage rather
  // than a correction — so the alternative is proven here, not assumed.
  const diamond = { ...registry.get("ss_polygonStar").defaults, w: W, h: H, points: 4, innerRatio: 1, cornerRadius: 0, startAngle: 0, x: 100, y: 50 };
  let doc = newDocument();
  const [withShape, shapeId] = withNewItem(doc, 0, diamond);
  const [withProbe, probeId] = withNewItem(withShape, 0, {
    ...registry.get("circle").defaults,
    x: `= @${shapeId}.x`, y: `= @${shapeId}.y`, w: `= @${shapeId}.w`, h: `= @${shapeId}.h`,
  });
  const ev = evaluateState(foldState(withProbe, 0), registry, "");
  assert.deepEqual(Object.keys(ev.errors ?? {}), [], "reading the stored box must not error");
  const p = ev.state.items[probeId];
  assert.deepEqual([p.x, p.y, p.w, p.h], [100, 50, W, H], "the stored box is exact and is NOT moved by the ink rule");
  // And the ink anchor really has moved away from it, or this proves nothing.
  const tl = registry.get("ss_polygonStar").anchors(diamond).find((a) => a.id === "tl");
  assert.ok(near(tl, { x: 0, y: 0 }) > 1, "premise: the diamond's `tl` must have left the box corner");
});

console.log(`\nanchor_ink_test: ${passed} passed`);
