/**
 * THE UNIVERSAL CONSTRAINT SWEEP — plain node, no framework (suite convention).
 * Run: node src/demo_apps/PowerRP/tests/universal_constraints_test.js
 *
 * WHY THIS EXISTS, in the user's words (R6-29): "We have to make sure that it's
 * universal for all widgets so that there's no Tower of Babel problem where they
 * all speak in different ways and do it different ways."
 *
 * So the thing under test is NOT "we converted the call sites". It is that A
 * WIDGET CANNOT HAVE ITS OWN DIALECT. Before R6-29 there were two answers to
 * "where may this handle go": `constrain(state, desired) → allowed`, declared by
 * eight plugins for their yellow-square modifier points, and a pair of booleans
 * (`doX`/`doY`) that the bbox move/resize path kept to itself. Those are the same
 * mathematical object written twice — "height is locked" IS "project the desired
 * (w, h) onto the nearest point of the line {(w, h₀)}" — and two spellings of one
 * idea is the defect this whole round exists to remove.
 *
 * WHAT IT PROVES, over EVERY REGISTERED WIDGET (builtinRoster, never a list):
 *   (1) CENSUS — every draggable affordance a widget exposes is one of the
 *       DECLARED families, and every family resolves through the ONE projection.
 *       A widget exposing an unclassified affordance turns this RED.
 *   (2) VOCABULARY GATE — the plugin hooks and capabilities that can CREATE a
 *       draggable affordance are a closed set. A new hook cannot quietly become a
 *       third dialect: it fails here until someone classifies it.
 *   (3) REFUSE-ALL — hand every seam a projection that allows nothing to move,
 *       and it must write NOTHING. A seam that ignored the projection would write.
 *   (4) REDIRECT — hand every seam a projection that sends every coordinate to a
 *       sentinel, and EVERY pair must carry the sentinel. This is the half that
 *       cannot be faked by an empty answer: it proves the written value came
 *       through `allowed`, not from `desired`.
 *   (5) APPLY NEVER SEES `desired` — the modifier-point family's half of the same
 *       claim, per widget, per handle.
 *   (6) MINIMAL DELTA — per widget, a pure-horizontal drag writes x ALONE and an
 *       east-only resize writes w ALONE, so an equation on the untouched axis
 *       survives. This is the discipline R6-29 must not regress, and it is the
 *       SAME rule as the projection: a coordinate held at its start value is
 *       dropped by the mechanism that drops one which merely did not move.
 *   (7) THE TWO SPELLINGS AGREE — zeroing a delta (what the gesture-level axis
 *       lock does) and pinning that axis's coordinates produce identical writes.
 *   (8) NEAREST — the bbox family's projections really are the nearest allowed
 *       record, sampled, not asserted. `core/registry.js` used to record that
 *       "nearest allowed" was an unenforced convention; it is a law with declared
 *       exemptions, and this is the bbox half of the enforcement (the
 *       modifier-point half is tests/handle_constraints_test.js).
 *   (9) A/B AGAINST THE OLD MACHINERY — the pre-R6-29 doX/doY + touch code, copied
 *       verbatim, run beside the new seam over a grid of rotations, scales,
 *       factors, axes, equation-valued extents and arrow endpoints. Byte-identical
 *       is the bar, and the ONE declared difference class is characterized rather
 *       than waved through.
 *  (10) NO BYPASS — `itemGeometryPairs` is not exported, and no canvas drag builds
 *       an item-geometry write by hand. Enforcement by module boundary is what
 *       makes (1) a fact about the code instead of a checklist.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: anything about pixels or pointer plumbing.
 * Whether the right handler runs on the right press is a browser probe's job
 * (tests/rotated_resize_probe.js, tests/multiresize_place_probe.js); this file is
 * about what the pure seam does once it is called.
 *
 * DECLARED EXEMPTIONS live in NOT_PROJECTED and INLINE_GEOMETRY_WRITES below,
 * each with the reason — an exemption with a reason is honest, a silently skipped
 * invariant is not. Both tables may only SHRINK.
 *
 * EXPECTED NOISE. Instantiating every widget's defaults makes a few plugins print
 * to stderr (a rasteriser with no browser). Those lines are not failures.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { UNCONSTRAINED, pinning, modifierWrite, constraintPull } from "../core/derive.js";
import { diffState } from "../core/deltas.js";
import {
  AXIS_COORDINATES, axisPinning, geometryPairs, translationPairs,
  scaleMemberPairs, scalePairs, rotationPairs, scaledBoxAboutPoint, resizedBox,
} from "../web/canvas/dragKinds.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster } from "../plugins/index.js";

const roster = builtinRoster();
// Paths resolve from THIS FILE, never process.cwd().
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// Tolerances: the same two tests/handle_constraints_test.js measured and named,
// reused rather than re-minted. POINT_EPS is a millionth of a local pixel.
const POINT_EPS = 1e-6;
/** The value the REDIRECT probe forces every coordinate to. Any number that no
 *  fixture start value can equal, so diffState keeps every key it lands on. */
const REDIRECT_SENTINEL = -987654.321;

// ── (1) THE AFFORDANCE CENSUS ────────────────────────────────────────────────

/**
 * EVERY WAY A WIDGET CAN OFFER SOMETHING DRAGGABLE, and the seam each resolves
 * through. This is the census's subject list, DERIVED per widget from what the
 * plugin declares — never a list of widget names.
 *
 * `exposedBy` reads DECLARED evidence only (a capability or a hook), because the
 * alternative is guessing from the type string, which the registry docblock
 * forbids in as many words ("tools/UI dispatch on these — NEVER on type").
 */
const DRAG_AFFORDANCES = Object.freeze({
  bodyDrag: {
    exposedBy: (p) => !!p.capabilities?.transform,
    seam: "translationPairs → geometryPairs",
    reason: "a body drag / drag-all / modal grab / arrow-key nudge translates x,y",
  },
  endpointTranslate: {
    exposedBy: (p) => typeof p.moveBy === "function",
    seam: "translationPairs (moveBy branch) → geometryPairs",
    reason: "a two-point widget translates its FREE endpoint coordinates instead of x,y",
  },
  handleResize: {
    exposedBy: (p) => !!(p.capabilities?.bbox && p.capabilities?.resizable),
    seam: "resizedBox → geometryPairs",
    reason: "the eight bbox resize handles",
  },
  collectiveScale: {
    exposedBy: (p) => !!(p.capabilities?.transform || typeof p.moveBy === "function"),
    seam: "scaleMemberPairs / scalePairs → geometryPairs",
    reason: "multi-resize about the collective box, and the S modal",
  },
  collectiveRotate: {
    exposedBy: (p) => !!(p.capabilities?.transform || typeof p.moveBy === "function"),
    seam: "rotationPairs → geometryPairs",
    reason: "the R modal, about the collective centre",
  },
  modifierPoint: {
    exposedBy: (p) => typeof p.modifierPoints === "function",
    seam: "modifierWrite = constrain then apply",
    reason: "the PPT yellow squares, the family that declared the protocol",
  },
  editPoint: {
    exposedBy: (p) => typeof p.editPoints === "function",
    seam: null, // DECLARED EXEMPTION — see NOT_PROJECTED
    reason: "the arrow family's world-space endpoint grab",
  },
  sceneCameraFly: {
    exposedBy: (p) => !!p.sceneCamera,
    seam: null, // DECLARED EXEMPTION — see NOT_PROJECTED
    reason: "a 3D viewport's mouse-look: web/sceneNav.js's onPan flies the camera",
  },
});

/**
 * Affordance families that do NOT yet resolve through the projection, with the
 * reason. This table may only SHRINK; it is a FINDING, not a licence.
 */
const NOT_PROJECTED = {
  editPoint:
    "web/CanvasView.svelte endpointDrag writes ['items', id, which, 'x'|'y'] straight to " +
    "setPreview, and the value it writes may be an EQUATION STRING (dropping an endpoint on " +
    "an anchor binds it). Routing it through the seam is not a rename: it would also subject " +
    "it to the minimal-delta rule it does not obey today, which changes drag outcomes — and " +
    "R6-29's bar is that outcomes do not change. Its owning module (core/endpoints.js) is also " +
    "held by another agent this round. Reported as the next step, not silently skipped.",
  sceneCameraFly:
    "FOUND BY THIS GATE, on the run that introduced it — the vocabulary check below went RED on an " +
    "unclassified `sceneCamera` hook that had landed since the census was written, which is exactly " +
    "the job. web/sceneNav.js:257 onPan turns a pointer drag into item-state writes and stages them " +
    "with app.setPreview directly, so it is a genuinely NEW draggable affordance that does not speak " +
    "the projection. It is also the cheapest one to convert: `sceneCamera.writes(state, pose)` already " +
    "returns the flat {key: value} record geometryPairs takes, so the conversion is one call, and it " +
    "would gain the minimal-delta rule at the same time. Not done here because the file is another " +
    "agent's in-flight work this round. Note the contrast that makes this a real distinction rather " +
    "than a catch-all: `interiorView` (the Mandelbrot, the map) declares NO onPan by an explicit user " +
    "ruling — its interior is driven from the wheel alone so a plain drag still MOVES the widget — so " +
    "it is correctly NOT a draggable affordance.",
};

/**
 * THE CLOSED HOOK VOCABULARY. Every top-level key a registered plugin may carry,
 * partitioned by whether it can create a DRAGGABLE AFFORDANCE.
 *
 * THIS IS A HAND-MAINTAINED MIRROR AND THAT IS THE POINT — it cannot be derived,
 * because only a human knows whether a newly invented hook puts something
 * draggable on the canvas. So it gets the treatment the convention ledger
 * prescribes for a mirror that cannot be derived: a gate that fails the moment
 * the two drift. A new hook lands RED here until it is classified, which is
 * exactly the moment to ask whether it needs the projection.
 */
const DRAGGABLE_HOOKS = new Set(["modifierPoints", "editPoints", "moveBy", "sceneCamera"]);
const NON_DRAGGABLE_HOOKS = new Set([
  "activate", "anchors", "capabilities", "cellGrid", "clipPolicy", "closestAnchor",
  "closestToward", "codeEditor", "commands", "cullMargin", "defaultFrameList", "defaults",
  "effectBounds", "effectsInjected", "emit", "fieldWrites", "floatingToolbar", "foldsSubtree",
  "handleToggles", "hitTest", "hitTestWorld", "inlineTextEdit", "insertPointAt", "inspector",
  "interiorView", "interpolateState", "isGhost", "itemRefs", "legacyKeys", "localBalls",
  "localBounds", "naturalSize", "placement", "placementAnchor", "presetFamilies", "presets",
  "primaryAsset",
  // `shatter` (core/shatter.js) is COMMAND-TIME, not drag-time, and this gate is
  // the right place to say so out loud. It runs once, from a palette entry,
  // returns a PLAN of whole item states, and never sees a pointer: no handle, no
  // preview, no per-frame write. Its output is ordinary items which then expose
  // their OWN affordances through this very census — a shattered box is an svg
  // widget and is constrained as one — so there is nothing here for the
  // projection to reach that it does not already reach.
  //
  // Worth contrasting with `armature` above, which IS classified draggable
  // despite adding no affordance of its own, because it changes what the
  // existing resize seam WRITES. `shatter` changes what EXISTS, before any drag
  // begins, and changes nothing about how anything is dragged afterwards. If a
  // future shatter ever gained an interactive "drag to split here" gesture, that
  // gesture would be a new hook and would land red here, which is correct.
  "shatter",
  // `shatterNotReady` is `shatter`'s CHEAP companion — one string or null,
  // answering "is this widget ready to be shattered right now" without planning.
  // Same classification for the same reason, and it is even further from a drag:
  // it is read by a command's `when`, never by a pointer.
  "shatterNotReady",
  "snapFeatures", "title", "toggleWrites", "toolGroups", "type",
]);
/** Capability keys, same partition, same reason. */
// `armature` is DRAGGABLE even though it adds no new affordance of its own: it
// changes what the EXISTING resize/scale seams WRITE (a similarity `scale`
// instead of w/h — web/canvas/dragKinds.js scaleMemberPairs), so it is read by
// the seam and a future author must not read it as unrelated to drags. The
// per-widget REFUSE-ALL / REDIRECT / minimal-delta sweeps below therefore cover
// its branch for free, which is the point of classifying it here rather than
// parking it with the render-only capabilities.
const DRAGGABLE_CAPABILITIES = new Set(["transform", "bbox", "resizable", "armature"]);
const NON_DRAGGABLE_CAPABILITIES = new Set([
  "backdrop", "docVars", "ghost", "metaball", "purgeable", "skyLight", "skyReader",
]);

/** Pure function. The affordance family ids widget `plugin` exposes.
 *  @example // affordancesOf({capabilities: {transform: true}}) → ["bodyDrag", "collectiveScale", "collectiveRotate"] */
function affordancesOf(plugin) {
  return Object.entries(DRAG_AFFORDANCES).filter(([, a]) => a.exposedBy(plugin)).map(([id]) => id);
}

// ── Fixtures: a plausible state and a plausible drag member per widget ───────
// The house trick (tests/handle_constraints_test.js STATE_VARIANTS): a plugin's
// own `defaults` may hold EQUATIONS — in the real app a hook only ever sees state
// that has been through evaluateState — so x/y/w/h are concretized here, and
// shape-conditional fields are filled by PRESENCE TEST on the defaults, never by
// type name.
const ENDPOINTS = { from: { x: 120, y: 200 }, to: { x: 420, y: 340 } };
const FLARE_LIGHT = { lightWorldX: 620, lightWorldY: 240 };
const BOX = { x: 40, y: -30, w: 240, h: 180, rotation: 0, scale: 1 };

/** Pure function. A concrete raw item state for an arbitrary widget. */
function stateFor(plugin, over = {}) {
  const d = plugin.defaults ?? {};
  return {
    ...d, type: plugin.type, ...BOX,
    ...(d.from ? ENDPOINTS : {}),
    ...(d.lightWorldX !== undefined ? FLARE_LIGHT : {}),
    ...over,
  };
}

/** Pure function. The drag `member` record CanvasView builds (translateMembers),
 *  for an arbitrary widget — the input every seam function takes. */
function memberFor(plugin, over = {}) {
  const state = stateFor(plugin, over);
  return {
    itemId: `it_${plugin.type}`,
    plugin,
    rawItem: state,
    startX: state.x, startY: state.y,
    startW: state.w, startH: state.h,
    startRotation: state.rotation ?? 0,
    startWorld: { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 },
  };
}

const CENTRE = { x: 300, y: 100 };
/** Every seam call a widget's non-modifier-point affordances make, as
 *  {family, label, run(constrain) → pairs}. ONE list, so (3) and (4) probe the
 *  same surface the census enumerates. */
function seamCallsFor(plugin) {
  const m = memberFor(plugin);
  const calls = [
    { family: "bodyDrag", label: "translationPairs", run: (c) => translationPairs(m, 37, 19, c) },
    { family: "collectiveScale", label: "scaleMemberPairs", run: (c) => scaleMemberPairs(m, 1.7, 2.3, CENTRE.x, CENTRE.y, c) },
    { family: "collectiveScale", label: "scalePairs", run: (c) => scalePairs({ ...m }, 1.7, CENTRE) },
    { family: "collectiveRotate", label: "rotationPairs", run: (c) => rotationPairs(m, 0.4, CENTRE, c) },
  ].filter(({ family }) => DRAG_AFFORDANCES[family].exposedBy(plugin));
  // The handle resize does its geometry in CanvasView (it needs drag.world and the
  // live snap state), then hands the desired BOX to the same seam. That final step
  // is what is universal, so it is what is probed — with the real resizedBox math
  // feeding it, not an invented rectangle.
  if (DRAG_AFFORDANCES.handleResize.exposedBy(plugin)) {
    const s = { x: m.startX, y: m.startY, w: m.startW, h: m.startH };
    const box = resizedBox([0, 0, s.w, s.h], { x: 55, y: -21 }, { east: true, south: true }, {});
    calls.push({
      family: "handleResize", label: "geometryPairs (resize)",
      run: (c) => geometryPairs(m.itemId, s, { x: s.x + box[0], y: s.y + box[1], w: box[2] - box[0], h: box[3] - box[1] }, c),
    });
  }
  // scalePairs takes an AXIS rather than a projection (it builds one), so it is
  // probed through its axis argument in test (7) instead of the (c) probes.
  return calls.filter((call) => call.label !== "scalePairs");
}

const CENSUS = roster.map((p) => ({ type: p.type, plugin: p, families: affordancesOf(p) }));
const PROJECTED = CENSUS.map((c) => ({ ...c, families: c.families.filter((f) => !NOT_PROJECTED[f]) }));

test(`census: every registered widget's affordances are declared (${roster.length} widgets)`, () => {
  const unknown = [];
  for (const { type, families } of CENSUS)
    for (const f of families)
      if (!DRAG_AFFORDANCES[f]) unknown.push(`${type}: ${f}`);
  assert.deepEqual(unknown, [], `undeclared affordance families:\n    ${unknown.join("\n    ")}`);
  // THE FLOOR. A sweep over a list can "pass" by covering nothing, so the types it
  // MUST reach are named — including LIBRARY widgets (donut, clock_analog), which
  // is what pins that builtinRoster() really includes the plugin-asset half.
  const covered = new Set(CENSUS.filter((c) => c.families.length).map((c) => c.type));
  for (const required of ["rect", "text", "group", "camera", "donut", "clock_analog", "arrow", "fancy_arrow", "polygon", "ss_radialSweep", "demo_lens_flare"])
    assert.ok(covered.has(required), `${required} exposes draggable affordances but the census did not reach it`);
  // Every declared family must be exposed by SOMEBODY — a family nobody has is a
  // dead declaration, and a dead declaration is how a table starts lying.
  for (const id of Object.keys(DRAG_AFFORDANCES))
    assert.ok(CENSUS.some((c) => c.families.includes(id)), `no registered widget exposes "${id}" — remove the declaration or fix its predicate`);
});

test("census: the DRAGGABLE-HOOK vocabulary is closed (a new hook cannot become a third dialect)", () => {
  const hooks = new Set(), caps = new Set();
  for (const p of roster) {
    for (const k of Object.keys(p)) hooks.add(k);
    for (const k of Object.keys(p.capabilities ?? {})) caps.add(k);
  }
  const strayHooks = [...hooks].filter((k) => !DRAGGABLE_HOOKS.has(k) && !NON_DRAGGABLE_HOOKS.has(k));
  assert.deepEqual(strayHooks.sort(), [],
    `unclassified plugin hook(s): ${strayHooks.join(", ")} — decide whether each puts something DRAGGABLE on the canvas and add it to DRAGGABLE_HOOKS (then give it a seam in DRAG_AFFORDANCES) or to NON_DRAGGABLE_HOOKS. Leaving it unclassified is how a second constraint dialect gets in.`);
  const strayCaps = [...caps].filter((k) => !DRAGGABLE_CAPABILITIES.has(k) && !NON_DRAGGABLE_CAPABILITIES.has(k));
  assert.deepEqual(strayCaps.sort(), [],
    `unclassified capability key(s): ${strayCaps.join(", ")} — same decision, same reason.`);
  // The classification must not be vacuous: every DRAGGABLE hook is really used.
  for (const h of DRAGGABLE_HOOKS) assert.ok(hooks.has(h), `DRAGGABLE_HOOKS lists "${h}" but no registered widget declares it`);
});

// ── (3) REFUSE-ALL and (4) REDIRECT: the projection is consulted and honoured ─

/** A projection that allows nothing to move — every coordinate held at its start. */
const REFUSE_ALL = (state, desired) => pinning(Object.keys(desired))(state, desired);
/** A projection that sends every coordinate somewhere the gesture never asked for. */
const REDIRECT = (state, desired) =>
  Object.fromEntries(Object.keys(desired).map((k) => [k, REDIRECT_SENTINEL]));

test("REFUSE-ALL: a projection that allows nothing makes every seam write nothing", () => {
  const failures = [];
  for (const { type, plugin } of PROJECTED)
    for (const call of seamCallsFor(plugin)) {
      let pairs;
      try { pairs = call.run(REFUSE_ALL); }
      catch (err) { failures.push(`${type} ${call.label}: threw — ${err.message.split("\n")[0]}`); continue; }
      if (pairs.length)
        failures.push(`${type} ${call.label}: wrote ${pairs.length} pair(s) through a projection that allows no movement — ${JSON.stringify(pairs).slice(0, 160)}`);
    }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

test("REDIRECT: every written value comes from `allowed`, never from `desired`", () => {
  const failures = [];
  for (const { type, plugin } of PROJECTED)
    for (const call of seamCallsFor(plugin)) {
      let pairs;
      try { pairs = call.run(REDIRECT); }
      catch (err) { failures.push(`${type} ${call.label}: threw — ${err.message.split("\n")[0]}`); continue; }
      if (pairs.length === 0) { failures.push(`${type} ${call.label}: wrote nothing — the probe cannot tell an honoured projection from a dead call`); continue; }
      for (const [path, value] of pairs)
        if (value !== REDIRECT_SENTINEL)
          failures.push(`${type} ${call.label}: ${path.join(".")} = ${value}, not the projected value — this seam computed its own answer and ignored the projection`);
    }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── (5) The modifier-point half: apply never sees the raw desired ────────────

test("modifier points: `apply` receives ONLY what `constrain` allowed, per widget per handle", () => {
  const failures = [];
  let handles = 0;
  const FIXED = { x: 17, y: -23 };
  for (const { type, plugin } of PROJECTED) {
    if (!DRAG_AFFORDANCES.modifierPoint.exposedBy(plugin)) continue;
    const state = stateFor(plugin);
    let points;
    try { points = plugin.modifierPoints(state) ?? []; }
    catch (err) { failures.push(`${type}: modifierPoints threw — ${err.message.split("\n")[0]}`); continue; }
    for (const raw of points) {
      if (!raw.apply) continue;
      handles += 1;
      // `constrain` is OPTIONAL on the plugin's own return and is defaulted ONCE,
      // by core/derive.nodeModifierPoints — which is the point of the default, so
      // the sweep enters through it rather than re-deciding what "absent" means.
      const mp = { ...raw, constrain: raw.constrain ?? UNCONSTRAINED };
      const pinned = { ...mp, constrain: () => ({ ...FIXED }) };
      try {
        // Two WILDLY different desired points, one constraint that collapses both
        // to the same allowed point: identical writes prove `apply` never read the
        // raw desired behind the projection's back.
        const a = modifierWrite(pinned, state, { x: 1e4, y: -1e4 });
        const b = modifierWrite(pinned, state, { x: -55, y: 3 });
        assert.deepEqual(a, b);
        // And the DECLARED constraint must actually be reachable through the driver.
        assert.deepEqual(modifierWrite(mp, state, FIXED), mp.apply(state, mp.constrain(state, FIXED)));
      } catch (err) {
        failures.push(`${type}/${mp.id}: ${err.message.split("\n")[0]}`);
      }
    }
  }
  assert.ok(handles > 40, `expected the whole modifier-point family, swept ${handles} handles`);
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── (6) The minimal-delta discipline, per widget ─────────────────────────────

test("minimal delta: a pure-horizontal drag writes x ALONE, for every widget that moves", () => {
  const failures = [];
  for (const { type, plugin } of PROJECTED) {
    if (!DRAG_AFFORDANCES.bodyDrag.exposedBy(plugin) || plugin.moveBy) continue;
    const keys = translationPairs(memberFor(plugin), 12, 0).map(([p]) => p[2]);
    if (JSON.stringify(keys) !== JSON.stringify(["x"]))
      failures.push(`${type}: wrote ${JSON.stringify(keys)} — an equation stored on y would be destroyed by a drag that never moved it`);
    const vkeys = translationPairs(memberFor(plugin), 0, 12).map(([p]) => p[2]);
    if (JSON.stringify(vkeys) !== JSON.stringify(["y"])) failures.push(`${type}: vertical drag wrote ${JSON.stringify(vkeys)}`);
    if (translationPairs(memberFor(plugin), 0, 0).length) failures.push(`${type}: a zero drag wrote something`);
  }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

test("minimal delta: an east-only resize writes w ALONE, for every resizable widget", () => {
  const failures = [];
  let checked = 0;
  for (const { type, plugin } of PROJECTED) {
    if (!DRAG_AFFORDANCES.handleResize.exposedBy(plugin)) continue;
    checked += 1;
    const s = { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h };
    const box = resizedBox([0, 0, s.w, s.h], { x: 30, y: 0 }, { east: true }, {});
    const keys = geometryPairs("r", s, { x: s.x + box[0], y: s.y + box[1], w: box[2] - box[0], h: box[3] - box[1] }).map(([p]) => p[2]);
    if (JSON.stringify(keys) !== JSON.stringify(["w"]))
      failures.push(`${type}: east-only resize wrote ${JSON.stringify(keys)} instead of ["w"]`);
  }
  assert.ok(checked > 20, `expected the resizable family, checked ${checked}`);
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

test("minimal delta: the untouched axis's stored EQUATION survives a real commit", () => {
  // The discipline stated at the level that matters: a delta with no `y` key
  // cannot overwrite a stored `y`, whatever that stored value is.
  const stored = { x: 300, y: "=100+shape_2.x" };
  const pairs = translationPairs({ itemId: "r", plugin: {}, startX: 300, startY: 20 }, 25, 0);
  const delta = Object.fromEntries(pairs.map(([p, v]) => [p[2], v]));
  const after = { ...stored, ...delta };
  assert.equal(after.y, "=100+shape_2.x");
  assert.equal(after.x, 325);
});

// ── (7) The two spellings of an axis constraint agree ────────────────────────

test("the axis lock and the axis PROJECTION are the same object, per widget", () => {
  // moveDrag suppresses an axis by zeroing the delta; the projection suppresses it
  // by pinning that axis's coordinates. Translation is a bijection between delta
  // space and position space, so the two must agree exactly — that equality is
  // what licenses replacing doX/doY with a projection rather than merely
  // re-describing it.
  const failures = [];
  for (const { type, plugin } of PROJECTED) {
    if (!DRAG_AFFORDANCES.bodyDrag.exposedBy(plugin)) continue;
    const m = memberFor(plugin);
    for (const [dx, dy] of [[11, 7], [-3, 19], [0, 5], [4, 0]]) {
      const zeroed = translationPairs(m, dx, 0);
      const projected = translationPairs(m, dx, dy, axisPinning("x"));
      if (JSON.stringify(zeroed) !== JSON.stringify(projected))
        failures.push(`${type} d=(${dx},${dy}) x-lock: zeroing ${JSON.stringify(zeroed)} ≠ projection ${JSON.stringify(projected)}`);
      const zeroedY = translationPairs(m, 0, dy);
      const projectedY = translationPairs(m, dx, dy, axisPinning("y"));
      if (JSON.stringify(zeroedY) !== JSON.stringify(projectedY))
        failures.push(`${type} d=(${dx},${dy}) y-lock: zeroing ${JSON.stringify(zeroedY)} ≠ projection ${JSON.stringify(projectedY)}`);
    }
  }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

test("the modal S axis constraint writes only its own axis, for every scalable widget", () => {
  const failures = [];
  for (const { type, plugin } of PROJECTED) {
    if (!DRAG_AFFORDANCES.collectiveScale.exposedBy(plugin)) continue;
    const m = memberFor(plugin);
    for (const [axis, allowed] of [["x", AXIS_COORDINATES.x.leaves], ["y", AXIS_COORDINATES.y.leaves]])
      for (const [path] of scalePairs(m, 1.9, CENTRE, axis)) {
        const leaf = path[path.length - 1];
        if (!allowed.includes(leaf))
          failures.push(`${type}: an S-modal constrained to ${axis} wrote ${path.slice(2).join(".")}, which belongs to the other axis`);
      }
  }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── (8) NEAREST, for the bbox family ─────────────────────────────────────────

test("NEAREST: the bbox projections really return the nearest allowed record", () => {
  // Sampled the same way tests/handle_constraints_test.js samples the modifier
  // points: perturb the answer in the record's own space and check no allowed
  // neighbour is strictly closer. A projection asserted to be nearest and never
  // measured is exactly the unenforced convention core/registry.js used to record.
  const RECORD = { x: 10, y: 20, w: 100, h: 50 };
  const DESIREDS = [
    { x: 0, y: 0, w: 0, h: 0 }, { x: 900, y: -400, w: 12, h: 3000 },
    { x: 10, y: 20, w: 100, h: 50 }, { x: -5.5, y: 20, w: 100.25, h: -2 },
  ];
  const dist = (a, b) => Math.sqrt(Object.keys(a).reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));
  const projections = [
    ["pinning([h])", pinning(["h"])],
    ["pinning([y,h])", pinning(["y", "h"])],
    ["axisPinning(x)", axisPinning("x")],
    ["axisPinning(y)", axisPinning("y")],
    ["UNCONSTRAINED", UNCONSTRAINED],
  ];
  for (const [label, constrain] of projections)
    for (const desired of DESIREDS) {
      const allowed = constrain(RECORD, desired);
      // IDEMPOTENT — a metric projection must be.
      assert.ok(dist(allowed, constrain(RECORD, allowed)) < POINT_EPS, `${label}: not idempotent`);
      // PULL agrees with the metric.
      assert.ok(Math.abs(constraintPull({ constrain }, RECORD, desired) - dist(desired, allowed)) < POINT_EPS, `${label}: pull disagrees with |p − constrain(p)|`);
      // NEAREST — perturb each coordinate both ways at three radii.
      const best = dist(desired, allowed);
      for (const radius of [0.5, 7, 300])
        for (const key of Object.keys(RECORD))
          for (const sign of [1, -1]) {
            const probe = { ...allowed, [key]: allowed[key] + sign * radius };
            if (dist(probe, constrain(RECORD, probe)) > POINT_EPS) continue; // not allowed
            assert.ok(dist(desired, probe) >= best - POINT_EPS,
              `${label}: an allowed record is closer to the desired one than the projection — ${dist(desired, probe)} < ${best}`);
          }
    }
});

// ── (9) A/B against the pre-R6-29 machinery ──────────────────────────────────

// THE OLD IMPLEMENTATION, copied verbatim from the commit before R6-29. It is the
// ORACLE: the claim "byte-identical drag outcomes" is only worth anything if the
// old code is here to disagree with.
function oldItemGeometryPairs(itemId, delta) {
  return Object.entries(delta).map(([k, v]) => [["items", itemId, k], v]);
}
function oldTranslationPairs(member, dx, dy) {
  if (member.plugin.moveBy)
    return member.plugin.moveBy(member.rawItem, dx, dy).map(([p, v]) => [["items", member.itemId, ...p], v]);
  const start = { x: member.startX, y: member.startY };
  const next = {
    x: typeof start.x === "number" ? start.x + dx : start.x,
    y: typeof start.y === "number" ? start.y + dy : start.y,
  };
  return oldItemGeometryPairs(member.itemId, diffState(start, next, ["x", "y"]));
}
function oldScaleMemberPairs(member, kx, ky, ax, ay, touch = { x: true, y: true }) {
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const pairs = [];
    for (const end of ["from", "to"])
      for (const coord of ["x", "y"]) {
        if (coord === "x" ? !touch.x : !touch.y) continue;
        const v = s[end]?.[coord];
        if (typeof v === "number") {
          const k = coord === "x" ? kx : ky;
          const a = coord === "x" ? ax : ay;
          pairs.push([["items", member.itemId, end, coord], a + k * (v - a)]);
        }
      }
    return pairs;
  }
  const rawItem = member.rawItem ?? {};
  const hasW = typeof rawItem.w === "number";
  const hasH = typeof rawItem.h === "number";
  const nb = scaledBoxAboutPoint(member, kx, ky, ax, ay);
  const keys = [];
  if (touch.x) keys.push("x");
  if (touch.y) keys.push("y");
  if (touch.x && hasW) keys.push("w");
  if (touch.y && hasH) keys.push("h");
  const start = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  return oldItemGeometryPairs(member.itemId, diffState(start, nb, keys));
}
function oldScalePairs(member, factor, c, axis = null) {
  const doX = axis !== "y";
  const doY = axis !== "x";
  return oldScaleMemberPairs(member, doX ? factor : 1, doY ? factor : 1, c.x, c.y, { x: doX, y: doY });
}

/**
 * Pure function. THE ONE DECLARED DIFFERENCE CLASS: the new seam may drop a pair
 * whose value the gesture did not actually change. Anything else is a regression.
 *
 * @example // onlyDropsNoOpWrites([[["items","a","to","y"],4]], [], {rawItem: {to: {y: 4}}}) // true
 */
function onlyDropsNoOpWrites(oldPairs, newPairs, member) {
  const key = (p) => JSON.stringify(p[0]);
  const byKey = new Map(newPairs.map((p) => [key(p), p[1]]));
  if (newPairs.length > oldPairs.length) return false;
  for (const p of oldPairs) {
    if (byKey.has(key(p))) { if (byKey.get(key(p)) !== p[1]) return false; continue; }
    let cur = member.rawItem;
    for (const seg of p[0].slice(2)) cur = cur?.[seg];
    if (cur !== p[1]) return false; // it really changed, and the new seam lost it
  }
  return true;
}

test("A/B: the new seam reproduces the old doX/doY + touch machinery exactly", () => {
  const ROTATIONS = [0, 0.001, Math.PI / 6, Math.PI / 2, 2.4, -1.1];
  const SCALES = [1, 0.25, 3.5];
  const RAWS = [{ w: 240, h: 180 }, { w: "= a.w", h: 180 }, { w: 240, h: "= a.h" }, {}];
  const FACTORS = [1, 2, 0.5, -1.5, 0];
  const CENTRES = [{ x: 0, y: 0 }, { x: 640, y: -120 }];
  const arrowPlugin = {
    moveBy: (raw, dx, dy) => {
      const out = [];
      for (const end of ["from", "to"])
        for (const coord of ["x", "y"]) {
          const v = raw[end]?.[coord];
          if (typeof v === "number") out.push([[end, coord], v + (coord === "x" ? dx : dy)]);
        }
      return out;
    },
  };
  const ARROWS = [
    { from: { x: 0, y: 0 }, to: { x: 100, y: 40 } },
    { from: { x: 5, y: "@c_tm.y" }, to: { x: 100, y: 40 } },
    { from: {}, to: { x: 3, y: 4 } },
  ];
  let compared = 0, declaredDrops = 0;
  const regressions = [];
  const cmp = (label, o, n, member) => {
    compared += 1;
    if (JSON.stringify(o) === JSON.stringify(n)) return;
    if (onlyDropsNoOpWrites(o, n, member)) { declaredDrops += 1; return; }
    regressions.push(`${label}\n      old ${JSON.stringify(o)}\n      new ${JSON.stringify(n)}`);
  };
  for (const rotation of ROTATIONS)
    for (const scale of SCALES)
      for (const rawItem of RAWS)
        for (const factor of FACTORS)
          for (const c of CENTRES)
            for (const axis of [null, "x", "y"]) {
              const m = {
                itemId: "r", plugin: {}, rawItem,
                startX: 40, startY: -30, startW: 240, startH: 180,
                startWorld: { x: 40, y: -30, rotation, scale },
              };
              cmp(`bbox rot=${rotation} s=${scale} f=${factor} axis=${axis} raw=${JSON.stringify(rawItem)}`,
                oldScalePairs(m, factor, c, axis), scalePairs(m, factor, c, axis), m);
              cmp(`multi-resize rot=${rotation} f=${factor}`,
                oldScaleMemberPairs(m, factor, 1, c.x, c.y), scaleMemberPairs(m, factor, 1, c.x, c.y), m);
            }
  for (const rawItem of ARROWS)
    for (const factor of FACTORS)
      for (const c of CENTRES)
        for (const axis of [null, "x", "y"]) {
          const m = { itemId: "a", plugin: arrowPlugin, rawItem, startX: 0, startY: 0, startW: 0, startH: 0, startWorld: { x: 0, y: 0, rotation: 0, scale: 1 } };
          cmp(`arrow f=${factor} axis=${axis} raw=${JSON.stringify(rawItem)}`,
            oldScalePairs(m, factor, c, axis), scalePairs(m, factor, c, axis), m);
        }
  for (const [dx, dy] of [[0, 0], [5, 0], [0, 7], [5, 3], [-11.25, 0.5]]) {
    for (const startX of [10, "circle.x + 10", undefined])
      for (const startY of [20, "=b.y", undefined]) {
        const m = { itemId: "r", plugin: {}, rawItem: {}, startX, startY };
        cmp(`translate d=(${dx},${dy}) start=(${startX},${startY})`, oldTranslationPairs(m, dx, dy), translationPairs(m, dx, dy), m);
      }
    for (const rawItem of ARROWS) {
      const m = { itemId: "a", plugin: arrowPlugin, rawItem };
      cmp(`arrow translate d=(${dx},${dy})`, oldTranslationPairs(m, dx, dy), translationPairs(m, dx, dy), m);
    }
  }
  assert.ok(compared > 3000, `the A/B grid must be wide enough to mean something — compared only ${compared}`);
  assert.equal(regressions.length, 0, `\n    ${regressions.join("\n    ")}`);
  // The declared class must actually OCCUR, or the classifier is untested and the
  // "0 regressions" above would also hold if the classifier were broken open.
  assert.ok(declaredDrops > 0, "the declared no-op-write drop class never occurred — the classifier is unexercised");
  console.log(`  note  A/B compared ${compared} cases: 0 regressions, ${declaredDrops} declared no-op-write drops (the endpoint branch joining the minimal-delta rule)`);
});

// ── (10) NO BYPASS: enforcement by module boundary and by source scan ────────

// Module namespaces are read HERE, at top level, because the `test` harness is
// SYNCHRONOUS: an async test body would be started and never awaited, so a failing
// assertion inside one would surface as an unhandled rejection printed AFTER the
// summary line rather than as a red test. Top-level await keeps the ordering honest.
const dragKindsModule = await import("../web/canvas/dragKinds.js");
const seamExports = new Map();
for (const rel of ["web/canvas/dragKinds.js", "core/derive.js"])
  seamExports.set(resolve(appRoot, rel), new Set(Object.keys(await import(resolve(appRoot, rel)))));

test("no bypass: itemGeometryPairs is NOT exported, so geometryPairs is the only door", () => {
  const mod = dragKindsModule;
  assert.equal(mod.itemGeometryPairs, undefined,
    "itemGeometryPairs is exported again — un-exporting it is what makes the projection unskippable rather than merely conventional");
  assert.equal(typeof mod.geometryPairs, "function");
  const src = readFileSync(resolve(appRoot, "web/canvas/dragKinds.js"), "utf8");
  assert.ok(!/^export function itemGeometryPairs/m.test(src));
});

/**
 * Canvas drags that build an item write BY HAND instead of going through the seam,
 * keyed on the normalized argument text so an edit unpins it loudly rather than
 * silently. This table may only SHRINK; each entry is a FINDING.
 */
const INLINE_GEOMETRY_WRITES = new Map([
  ['[[["items",drag.itemId,drag.which,"x"],xy.x],[["items",drag.itemId,drag.which,"y"],xy.y],]',
    "endpointDrag — see NOT_PROJECTED.editPoint. The written value may be an equation string, and routing it through the seam would also subject it to the minimal-delta rule it does not obey today."],
]);

test("no bypass: no canvas drag hand-builds an item-geometry write", () => {
  const src = readFileSync(resolve(appRoot, "web/CanvasView.svelte"), "utf8");
  const found = [];
  for (let i = src.indexOf("app.setPreview("); i !== -1; i = src.indexOf("app.setPreview(", i + 1)) {
    // Balanced-paren extraction of the argument — a regex cannot do this, and a
    // line-based scan would miss the multi-line calls, which are the ones at risk.
    let depth = 0, j = i + "app.setPreview".length, start = j + 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth += 1;
      else if (src[j] === ")") { depth -= 1; if (depth === 0) break; }
    }
    const arg = src.slice(start, j);
    if (!arg.includes('["items"')) continue;
    const normalized = arg.replace(/\s+/g, "");
    const line = src.slice(0, i).split("\n").length;
    if (INLINE_GEOMETRY_WRITES.has(normalized)) { found.push(normalized); continue; }
    assert.fail(`web/CanvasView.svelte:${line} builds an item write by hand instead of calling canvas/dragKinds.js geometryPairs:\n      ${arg.trim().slice(0, 200)}\n    If it genuinely cannot use the seam, add it to INLINE_GEOMETRY_WRITES above WITH ITS REASON — an exemption with a reason is honest, an unexplained bypass is the Tower of Babel returning.`);
  }
  for (const [normalized, why] of INLINE_GEOMETRY_WRITES)
    assert.ok(found.includes(normalized), `INLINE_GEOMETRY_WRITES still exempts a write that no longer exists (${why.slice(0, 60)}…) — drop the entry`);
});

/**
 * The modules whose EXPORT SURFACE the seam depends on. A name imported from one
 * of these must actually exist.
 *
 * WHY THIS CHECK EXISTS, and it is not hypothetical. R6-29 un-exported
 * `itemGeometryPairs` while two call sites still imported it, and THE PRODUCTION
 * BUILD DID NOT NOTICE: the lead ran the real PowerRP config to completion — exit
 * 0, bundle emitted, not one warning mentioning the name. Rollup resolves a
 * missing named import to `undefined` and ships it, so the failure would have
 * been `itemGeometryPairs is not a function` in a user's hands, on a green build,
 * only when they dragged a resize handle. A silent-by-default toolchain is
 * exactly the wrong place to rest a "structurally impossible" guarantee, so the
 * guarantee gets its own gate.
 *
 * SCOPED TO THESE TWO ON PURPOSE. The same check over every local import in the
 * app would be strictly more valuable and is a one-line change to this list —
 * but it would also go red for any other in-flight file's unrelated breakage,
 * and a gate that fails for reasons outside its own subject teaches people to
 * ignore it. Widen it when the tree is quiet.
 */
const EXPORT_SURFACE = [...seamExports.keys()];
const IMPORT_SCAN_DIRS = ["web", "web/canvas", "core", "cli", "plugins", "plugins/demo", "tests"];

test("no bypass: every name imported from the seam modules actually EXISTS", () => {
  const targets = seamExports;
  const failures = [];
  let checked = 0;
  const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const dir of IMPORT_SCAN_DIRS)
    for (const name of readdirSync(resolve(appRoot, dir))) {
      if (!/\.(js|mjs|svelte)$/.test(name)) continue;
      const file = resolve(appRoot, dir, name);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(IMPORT_RE)) {
        if (!m[2].startsWith(".")) continue;
        const resolved = resolve(dirname(file), m[2]);
        const exported = targets.get(resolved);
        if (!exported) continue;
        for (const clause of m[1].split(",")) {
          const imported = clause.trim().split(/\s+as\s+/)[0].trim();
          if (!imported) continue;
          checked += 1;
          if (!exported.has(imported))
            failures.push(`${dir}/${name} imports { ${imported} } from ${m[2]}, which does not export it — the bundler will silently substitute undefined`);
        }
      }
    }
  assert.ok(checked > 20, `the import scan must actually reach the seam's consumers — checked only ${checked} names`);
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
  console.log(`  note  verified ${checked} imported names against the ${EXPORT_SURFACE.length} seam modules' real exports`);
});

console.log(`\n  ${Object.keys(NOT_PROJECTED).length} declared affordance exemption, ${INLINE_GEOMETRY_WRITES.size} declared inline-write exemption`);
console.log(`  census: ${CENSUS.filter((c) => c.families.length).length} of ${roster.length} registered widgets expose a draggable affordance; ${Object.keys(DRAG_AFFORDANCES).length} families declared`);
console.log(`\nuniversal_constraints_test: ${passed} tests passed over ${roster.length} registered widgets`);
