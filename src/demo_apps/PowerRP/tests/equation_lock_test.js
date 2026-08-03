/**
 * R6-28 EQUATION LOCK — the projection, the seam, and the divergence gate.
 *
 * ── WHAT THE FEATURE IS ──────────────────────────────────────────────────────
 * A toolbar toggle (the chain link). While it is ARMED, any property driven by an
 * `=` equation is READ-ONLY to canvas gestures: dragging, resizing and rotating
 * lose that degree of freedom rather than overwriting the binding with the number
 * it currently evaluates to. Off by default, by user ruling.
 *
 * ── THE LAW THIS SUITE ENFORCES, AND WHY THE OBVIOUS TEST IS TOO WEAK ────────
 * "The locked coordinate did not change" is NOT the property that matters, and a
 * suite that checked it would pass on a broken implementation. A drag that writes
 * `y` back at the value its equation happens to evaluate to right now leaves the
 * SAME picture on screen and has destroyed the binding: the next slide's tween,
 * the next change to the thing it referenced, and the author's intent are all
 * gone, silently. So every assertion here is that the key is **ABSENT FROM THE
 * WRITE** — no pair, no path, nothing for `commitPreview` to keyframe. That is
 * the same property the minimal-delta discipline enforces one step over
 * (core/deltas.js diffState), and it is enforced the same way: by the key not
 * being in the delta at all.
 *
 * ── WHY IT IS ONE WIRING AND NOT TWO ─────────────────────────────────────────
 * R6-29 unified the constraint protocol: `constrain(state, desired) → allowed`
 * takes a coordinate RECORD, `pinning(keys)` is the projection that holds named
 * coordinates fixed, and `geometryPairs` is the ONE door every item-geometry
 * write goes through. The equation lock is therefore a `pinning` composed into
 * that door — `web/canvas/equationBinding.js equationPinning` — and NOT a second
 * interaction layer. This suite proves the composition rather than trusting it:
 *
 *   (1) equationBoundKeys recognises what an equation IS, including the two
 *       spellings that are easy to miss (leading whitespace, and the legacy BARE
 *       STRING in a numeric slot).
 *   (2) THE ROSTER SWEEP. Every registered widget, every seam it exposes: a
 *       locked coordinate is absent from the write, and the ones that are NOT
 *       locked are still written. A widget cannot have a dialect, because the
 *       enumeration comes from the live roster and never from a list here.
 *   (3) The lock COMPOSES with the gesture-level axis lock rather than replacing
 *       it (scalePairs' new `constrain` argument).
 *   (4) THE COUPLED-GESTURE LAW. A resize computes `x` and `w` jointly, so
 *       record-space pinning alone would SLIDE a widget whose `w` is locked when
 *       the west edge is grabbed. The gesture-space projection
 *       (deltaWithoutRefused) is what makes it refuse instead, and this
 *       reproduces CanvasView's exact composition to prove it.
 *   (5) OFF IS OFF. With no lock the writes are byte-identical to today's.
 *   (6) THE DIVERGENCE GATE (ledger C-10). "Is this stored leaf an equation" had
 *       four hand-copies before this round; a dedup with no gate has fixed today
 *       and nothing else, so a fifth copy fails this run.
 *
 * EXPECTED NOISE: instantiating every widget's defaults makes a few plugins print
 * to stderr (a rasteriser with no browser). Those lines are not failures.
 *
 * Run: node tests/equation_lock_test.js
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { UNCONSTRAINED } from "../core/derive.js";
import {
  geometryPairs, translationPairs, translationRecord, scaleMemberPairs, scalePairs, rotationPairs,
  resizedBox, resizeStoredState, refusedCoordinates, deltaWithoutRefused, DRAG_KINDS,
} from "../web/canvas/dragKinds.js";
import { equationBoundKeys, equationPinning, equationLockNote } from "../web/canvas/equationBinding.js";
// builtinRoster(), NOT allPlugins — the same reason tests/universal_constraints_test.js
// gives: allPlugins is only the source-module half, and the five widgets that moved to
// the built-in plugin-asset library silently left every sweep that used it.
import { builtinRoster } from "../plugins/index.js";

const roster = builtinRoster();
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/**
 * Pure function. A stand-in for the app store with ONE method, because
 * `equationBoundKeys` uses exactly one: `storedItemValue(itemId, path)`. Narrow on
 * purpose — a fake that offered more would let a future implementation reach for
 * app state this query is not allowed to depend on and still pass.
 *
 * @param {object} stored - the item's RAW stored state (equations as strings)
 * @returns {{storedItemValue: function}}
 *
 * @example fakeApp({x: 5}).storedItemValue("anything", ["x"]) // 5
 * @example fakeApp({from: {x: "= a.x"}}).storedItemValue("i", ["from", "x"]) // "= a.x"
 */
function fakeApp(stored) {
  return { storedItemValue: (_itemId, path) => path.reduce((node, key) => (node ?? {})[key], stored) };
}

// ── (1) WHAT COUNTS AS AN EQUATION ───────────────────────────────────────────

// A minimal plugin: only `defaults` matters, because that is what tells
// isEquationValue which slots are NUMERIC and therefore accept the legacy
// bare-string spelling.
const BOX_PLUGIN = { type: "probe_box", defaults: { x: 0, y: 0, w: 100, h: 50, label: "hello" } };

test("equationBoundKeys: the two spellings, and what is NOT one", () => {
  const app = fakeApp({
    x: 10,                 // a plain number
    y: "= 3 * 7",          // the universal "=" marker
    w: "  = other.h",      // leading whitespace is tolerated (EQ_PREFIX_RE)
    h: "other.h",          // the LEGACY bare string, in a numeric slot
    label: "plain text",   // a bare string in a STRING slot is just text
  });
  assert.deepEqual(equationBoundKeys(app, "i", BOX_PLUGIN, ["x", "y", "w", "h", "label"]), ["y", "w", "h"]);
  assert.deepEqual(equationBoundKeys(app, "i", BOX_PLUGIN, []), []);
  assert.deepEqual(equationBoundKeys(app, "i", BOX_PLUGIN, ["nope"]), [], "an absent leaf is not an equation");
});

test("equationBoundKeys: a DOTTED key is a stored PATH, which is what the arrow family needs", () => {
  const arrow = { type: "probe_arrow", defaults: { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } } };
  const app = fakeApp({ from: { x: "@circle_tm.x", y: 4 }, to: { x: 9, y: "= 2 + 2" } });
  // "@…" is the anchor-binding spelling an endpoint drop writes; it is a bare
  // string in a numeric slot, so it is an equation by the same rule.
  assert.deepEqual(equationBoundKeys(app, "a", arrow, ["from.x", "from.y", "to.x", "to.y"]), ["from.x", "to.y"]);
});

test("equationPinning: the pinned coordinate comes back at its START value, and only that one", () => {
  const app = fakeApp({ x: 10, y: "= 3 * 7", w: 100, h: 50 });
  const start = { x: 10, y: 21, w: 100, h: 50 };
  const allowed = equationPinning(app, "i", BOX_PLUGIN)(start, { x: 99, y: 99, w: 99, h: 99 });
  assert.deepEqual(allowed, { x: 99, y: 21, w: 99, h: 99 });
});

test("equationPinning: IDEMPOTENT, which is what licenses applying it twice (gesture space, then record space)", () => {
  const app = fakeApp({ x: 10, y: "= 3 * 7", w: 100, h: 50 });
  const lock = equationPinning(app, "i", BOX_PLUGIN);
  const start = { x: 10, y: 21, w: 100, h: 50 };
  const once = lock(start, { x: 99, y: 99, w: 99, h: 99 });
  assert.deepEqual(lock(start, once), once);
});

// ── (2) THE ROSTER SWEEP: ABSENT FROM THE WRITE, PER WIDGET, PER SEAM ────────

const BOX = { x: 40, y: -30, w: 240, h: 180, rotation: 0, scale: 1 };
const ENDPOINTS = { from: { x: 120, y: 200 }, to: { x: 420, y: 340 } };
const CENTRE = { x: 300, y: 100 };

/** Pure function. A concrete raw item state for an arbitrary widget — the
 *  house trick (tests/universal_constraints_test.js stateFor): a plugin's own
 *  defaults may hold equations, and a hook only ever sees evaluated state, so the
 *  geometry keys are concretized and shape-conditional fields are filled by
 *  PRESENCE TEST on the defaults, never by type name. */
function stateFor(plugin, over = {}) {
  const d = plugin.defaults ?? {};
  return { ...d, type: plugin.type, ...BOX, ...(d.from ? ENDPOINTS : {}), ...over };
}

/** Pure function. The drag `member` record CanvasView builds (translateMembers),
 *  for an arbitrary widget, with `rawItem` overridden so chosen keys hold an
 *  EQUATION STRING — which is what makes the lock bite. */
function memberFor(plugin, equationKeys = []) {
  const state = stateFor(plugin);
  const rawItem = { ...state };
  for (const key of equationKeys) {
    const path = key.split(".");
    let node = rawItem;
    for (const seg of path.slice(0, -1)) node = node[seg] = { ...node[seg] };
    node[path.at(-1)] = `= ${path.at(-1)}_source`;
  }
  return {
    itemId: `it_${plugin.type}`, plugin, rawItem,
    startX: state.x, startY: state.y, startW: state.w, startH: state.h,
    startRotation: state.rotation ?? 0,
    startWorld: { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 },
  };
}

/** Pure function. The stored keys a pair list writes, as dotted paths — what
 *  "absent from the write" is measured over. */
function writtenKeys(pairs) {
  return pairs.map(([path]) => path.slice(2).join("."));
}

/** Every seam call a widget's bbox-family affordances make, as
 *  {label, run(constrain) → pairs}. ONE list, so the locked and unlocked sweeps
 *  probe exactly the same surface. */
function seamCallsFor(plugin, member) {
  const calls = [
    { label: "translationPairs (body drag / modal grab / nudge)", run: (c) => translationPairs(member, 37, 19, c) },
    { label: "scaleMemberPairs (multi-resize)", run: (c) => scaleMemberPairs(member, 1.7, 2.3, CENTRE.x, CENTRE.y, c) },
    { label: "scalePairs (S modal)", run: (c) => scalePairs(member, 1.7, CENTRE, null, c) },
    { label: "rotationPairs (R modal)", run: (c) => rotationPairs(member, 0.4, CENTRE, c) },
  ];
  if (plugin.capabilities?.bbox && plugin.capabilities?.resizable) {
    const s = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
    const box = resizedBox([0, 0, s.w, s.h], { x: 55, y: -21 }, { east: true, south: true }, {});
    const desired = resizeStoredState(box, member.startWorld, false, s);
    calls.push({ label: "geometryPairs (handle resize)", run: (c) => geometryPairs(member.itemId, s, desired, c) });
  }
  return calls;
}

// The geometry keys a bbox widget stores, plus the arrow family's endpoint
// coordinates — the coordinates a canvas gesture can reach. Locked ONE AT A TIME
// so the sweep says which key failed, not merely that something did.
const LOCKABLE = ["x", "y", "w", "h", "rotation", "scale"];
const LOCKABLE_ENDPOINTS = ["from.x", "from.y", "to.x", "to.y"];

/**
 * Pure function. Whether this widget + seam may answer a lock by refusing the
 * WHOLE gesture rather than losing one degree of freedom.
 *
 * ONE DECLARED EXEMPTION, AND IT IS PRE-EXISTING RATHER THAN THE LOCK'S DOING.
 * An ARMATURE (a group) scales by its single scalar `scale`, and its x/y are pure
 * COMPENSATION for that factor — the back-solve that keeps the grabbed anchor
 * fixed. `scaleMemberPairs`' armature branch has always asked the projection
 * whether both axes are free (`constrain({x:0,y:0},{x:1,y:1})`) and answered the
 * identity when either is pinned, on the stated ground that a uniform scale moves
 * the group on BOTH axes so pinning either leaves the identity as the only common
 * point. The equation lock inherits that answer; it did not introduce it, and the
 * same sentence was already true of `S X` on a group.
 *
 * IT IS COARSER THAN IT NEEDS TO BE, and that is worth recording rather than
 * hiding: a group scaled about its OWN grabbed corner would not move `x` at all,
 * so an `x` binding need not have refused it. The probe cannot tell, because it
 * does not see the anchor. Reported as a finding, not fixed here — narrowing it
 * changes `S X` behaviour on groups, which is outside this task.
 *
 * @param {object} plugin - a registered widget
 * @param {string} label - the seam call's label
 * @returns {boolean}
 *
 * @example mayRefuseWholeGesture({capabilities: {armature: true}}, "scalePairs (S modal)") // true
 * @example mayRefuseWholeGesture({capabilities: {bbox: true}}, "scalePairs (S modal)") // false
 */
function mayRefuseWholeGesture(plugin, label) {
  return !!plugin.capabilities?.armature && label.startsWith("scale");
}

test("ROSTER SWEEP: a locked coordinate is ABSENT FROM THE WRITE at every seam, for every registered widget", () => {
  let cases = 0, bitten = 0, wholeRefusals = 0;
  for (const plugin of roster) {
    const keys = [...LOCKABLE, ...(plugin.defaults?.from ? LOCKABLE_ENDPOINTS : [])];
    for (const locked of keys) {
      const member = memberFor(plugin, [locked]);
      const app = fakeApp(member.rawItem);
      const lock = equationPinning(app, member.itemId, plugin);
      for (const { label, run } of seamCallsFor(plugin, member)) {
        const free = writtenKeys(run(UNCONSTRAINED));
        const held = writtenKeys(run(lock));
        cases += 1;
        assert.ok(!held.includes(locked),
          `${plugin.type} / ${label}: locked "${locked}" WAS WRITTEN (${JSON.stringify(held)}). ` +
          `Writing it back at its evaluated value is exactly the silent destruction the lock exists to prevent.`);
        // The other half, and it is the half an "allow nothing" bug cannot fake:
        // every key the lock did NOT hold must still be written, so the gesture
        // keeps the degrees of freedom it is entitled to.
        if (held.length === 0 && mayRefuseWholeGesture(plugin, label)) { wholeRefusals += 1; continue; }
        for (const key of free) if (key !== locked)
          assert.ok(held.includes(key),
            `${plugin.type} / ${label}: locking "${locked}" also suppressed "${key}", which no equation governs. ` +
            `The lock is per DEGREE OF FREEDOM; refusing a whole gesture is a different (and wrong) feature.`);
        if (free.includes(locked)) bitten += 1;
      }
    }
  }
  // The exemption must not be vacuous OR unbounded: armatures really do take it,
  // and nothing else may.
  assert.ok(wholeRefusals > 0, "the armature whole-gesture exemption never fired — drop it, or the sweep has stopped reaching groups");
  console.log(`  note  ${wholeRefusals} declared armature whole-gesture refusals`);
  // A sweep where the lock never actually had anything to hold would pass
  // vacuously. It must BITE — i.e. some cases must have written the key without
  // the lock and not written it with one.
  assert.ok(bitten > 100, `the sweep barely bit (${bitten} of ${cases} cases) — it is not measuring the lock`);
  console.log(`  note  ${cases} widget x key x seam cases; the lock actually suppressed a write in ${bitten}`);
});

test("ROSTER SWEEP: with the lock OFF, every seam writes exactly what it wrote before R6-28", () => {
  for (const plugin of roster) {
    const member = memberFor(plugin, ["x", "y", "w", "h"]);
    for (const { label, run } of seamCallsFor(plugin, member)) {
      // UNCONSTRAINED is the protocol's own identity, and the DEFAULT of every
      // one of these parameters, so calling with it and calling with nothing must
      // agree — that equality is what makes "off by default" free of risk.
      assert.deepEqual(run(UNCONSTRAINED), run(undefined), `${plugin.type} / ${label}: the explicit identity and the default disagree`);
    }
  }
});

// ── (3) COMPOSITION WITH THE GESTURE-LEVEL AXIS LOCK ─────────────────────────

const PROBE_BOX_PLUGIN = { type: "probe_box", capabilities: { transform: true, bbox: true, resizable: true }, defaults: BOX };

test("the item lock COMPOSES with the modal axis constraint instead of replacing it", () => {
  const member = memberFor(PROBE_BOX_PLUGIN, ["x"]);
  const lock = equationPinning(fakeApp(member.rawItem), member.itemId, PROBE_BOX_PLUGIN);
  // The four corners of the composition, and the point is the LAST one: it is
  // strictly smaller than either restriction alone, so neither won — the pinned
  // key sets were UNIONED. `x` is chosen deliberately as a coordinate the X-axis
  // constraint does NOT pin, which is what makes the union visible.
  assert.deepEqual(writtenKeys(scalePairs(member, 2, CENTRE)), ["x", "y", "w", "h"], "unconstrained: all four");
  assert.deepEqual(writtenKeys(scalePairs(member, 2, CENTRE, null, lock)), ["y", "w", "h"], "lock alone holds x");
  assert.deepEqual(writtenKeys(scalePairs(member, 2, CENTRE, "x")), ["x", "w"], "S X alone holds the y axis");
  assert.deepEqual(writtenKeys(scalePairs(member, 2, CENTRE, "x", lock)), ["w"], "both: the union of {y,h} and {x}");
});

test("FINDING PINNED: an equation-bound `w` is ALREADY protected on the scale path and NOT on the handle path", () => {
  // W3-A's F5, made executable rather than left as prose. `scaleMemberPairs`
  // refuses to write a `w` whose RAW stored value is not a number (its own
  // documented rule: scaling drives an equation's inputs, not its result), so on
  // that path the lock changes nothing. The single-item HANDLE resize has no such
  // rule and overwrites the equation with a literal — which is exactly the hole
  // R6-28 closes, and exactly why the lock is a TOGGLE rather than the default:
  // today's two answers to "may a drag overwrite an equation" are both shipped.
  const member = memberFor(PROBE_BOX_PLUGIN, ["w"]);
  assert.ok(!writtenKeys(scalePairs(member, 2, CENTRE)).includes("w"),
    "the scale path already preserves an equation-valued w with NO lock");
  const s = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  const box = resizedBox([0, 0, s.w, s.h], { x: 55, y: 0 }, { east: true }, {});
  const unlocked = geometryPairs(member.itemId, s, resizeStoredState(box, member.startWorld, false, s));
  assert.deepEqual(writtenKeys(unlocked), ["w"],
    "the handle path overwrites it — if this ever stops being true the two paths have been unified and this finding is stale");
  const lock = equationPinning(fakeApp(member.rawItem), member.itemId, PROBE_BOX_PLUGIN);
  assert.deepEqual(writtenKeys(geometryPairs(member.itemId, s, resizeStoredState(box, member.startWorld, false, s), lock)), [],
    "…and the lock is what closes it");
});

// ── (4) THE COUPLED-GESTURE LAW ──────────────────────────────────────────────

/** The exact composition web/CanvasView.svelte resizeDrag performs: probe the box
 *  the raw delta would produce, ask the projection what it refuses, re-run with
 *  those gesture axes zeroed, then write through the seam. Reproduced here rather
 *  than approximated, because the whole point is that the two spaces agree. */
function resizeThroughSeam(member, lock, delta, edges) {
  const s = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  const world = member.startWorld;
  const probe = resizeStoredState(resizedBox([0, 0, s.w, s.h], delta, edges, {}), world, false, s);
  const live = deltaWithoutRefused(delta, refusedCoordinates(lock, s, probe));
  const box = resizedBox([0, 0, s.w, s.h], live, edges, {});
  return geometryPairs(member.itemId, s, resizeStoredState(box, world, false, s), lock);
}

test("COUPLED GESTURE: a locked `w` REFUSES a west-edge drag instead of sliding the widget", () => {
  const member = memberFor(PROBE_BOX_PLUGIN, ["w"]);
  const lock = equationPinning(fakeApp(member.rawItem), member.itemId, PROBE_BOX_PLUGIN);
  const west = { west: true, east: false, north: false, south: false };
  // THE DEFECT THIS PINS. Record-space pinning ALONE holds `w` while `x` still
  // tracks the cursor, so the box keeps its width and MOVES — a resize handle
  // that translates the widget. The gesture-space pass is what turns that into a
  // refusal, and the assertion is on the whole write being empty.
  const naive = geometryPairs(member.itemId,
    { x: member.startX, y: member.startY, w: member.startW, h: member.startH },
    resizeStoredState(resizedBox([0, 0, member.startW, member.startH], { x: -60, y: 0 }, west, {}), member.startWorld, false, { x: member.startX, y: member.startY }),
    lock);
  assert.deepEqual(writtenKeys(naive), ["x"], "precondition: record-space pinning alone really does write a lone x (the slide)");
  assert.deepEqual(resizeThroughSeam(member, lock, { x: -60, y: 0 }, west), [], "the composed gesture writes NOTHING");
});

test("COUPLED GESTURE: a locked `h` leaves a CORNER resizing the width alone (the user's own example)", () => {
  const member = memberFor(PROBE_BOX_PLUGIN, ["h"]);
  const lock = equationPinning(fakeApp(member.rawItem), member.itemId, PROBE_BOX_PLUGIN);
  const corner = { west: false, east: true, north: false, south: true };
  assert.deepEqual(writtenKeys(resizeThroughSeam(member, lock, { x: 55, y: -21 }, corner)), ["w"],
    "a corner with one axis locked is NOT dead — it must still resize the other");
  // And with nothing locked the same corner drives both, so the previous line is
  // measuring the lock rather than a corner that only ever wrote w.
  assert.deepEqual(writtenKeys(resizeThroughSeam(member, UNCONSTRAINED, { x: 55, y: -21 }, corner)), ["w", "h"]);
});

test("COUPLED GESTURE: a locked `x` does NOT stop an east-edge drag — it was never going to move x", () => {
  const member = memberFor(PROBE_BOX_PLUGIN, ["x"]);
  const lock = equationPinning(fakeApp(member.rawItem), member.itemId, PROBE_BOX_PLUGIN);
  const east = { west: false, east: true, north: false, south: false };
  assert.deepEqual(writtenKeys(resizeThroughSeam(member, lock, { x: 55, y: 0 }, east)), ["w"],
    "the gesture-space pass must fire on what the gesture WOULD HAVE MOVED, not on the mere existence of a lock");
});

// ── (5) THE DIVERGENCE GATE (ledger C-10) ────────────────────────────────────

/**
 * Pure function. `src` with its comments removed, so a grep gate cannot count a
 * sentence in prose as code (ledger C-14 — two agents hit that from opposite
 * sides in one hour). The line-comment stripper uses `[ \t]*`, never `^\s*`:
 * `\s` matches a newline, so the greedy form eats the blank line above a comment
 * and every subsequent line number drifts.
 *
 * @param {string} src - JavaScript or Svelte source text
 * @returns {string} the same text with block and line comments blanked
 *
 * @example stripComments("a = 1; // note\nb = 2;") // "a = 1; \nb = 2;"
 * @example // a block comment goes too (spelled with String.raw here because the
 * @example // closing marker cannot appear literally inside this docstring):
 * @example stripComments(String.raw`/*gone*` + "/\nkept") // "\nkept"
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[ \t]*\/\/[^\n]*/g, "");
}

/** The ONE module allowed to pair `isEquationValue` with a `storedItemValue`
 *  read. Everything else asks it. */
const EQUATION_BINDING_MODULE = "web/canvas/equationBinding.js";

test("DIVERGENCE GATE: nothing outside equationBinding.js re-derives 'is this stored leaf an equation'", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(resolve(appRoot, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(resolve(appRoot, rel)).isDirectory()) { if (name !== "dist" && name !== "node_modules") walk(rel); continue; }
      if (!/\.(js|mjs|svelte)$/.test(name) || rel === EQUATION_BINDING_MODULE) continue;
      const src = stripComments(readFileSync(resolve(appRoot, rel), "utf8"));
      // THE DEFECT SHAPE, not a name list: `isEquationValue(` applied to the
      // result of a `storedItemValue(` read, within one call. Derived from the
      // expression itself, so a copy under any local function name is caught.
      for (const m of src.matchAll(/isEquationValue\([^;]*?storedItemValue\(/gs))
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
    }
  };
  walk("web");
  walk("core");
  assert.deepEqual(offenders, [],
    `a fifth copy of the equation-binding query appeared at ${offenders.join(", ")}. ` +
    `Call ${EQUATION_BINDING_MODULE} equationBoundKeys instead — that module's header records the four copies this one replaced, ` +
    `and ledger C-10 records that a dedup without a gate has fixed today and nothing else.`);
});

test("DIVERGENCE GATE: the gate can actually fail (it detects the shape in a fixture)", () => {
  // A gate that cannot fail is not a gate. The pattern is exercised on synthetic
  // text so the check is proven live rather than assumed from an empty result.
  const fixture = stripComments('const bound = isEquationValue(plugin, [k], app.storedItemValue(id, [k])); // copy');
  assert.equal([...fixture.matchAll(/isEquationValue\([^;]*?storedItemValue\(/gs)].length, 1);
  assert.equal([...stripComments("// isEquationValue(p, [k], app.storedItemValue(i, [k]))").matchAll(/isEquationValue\([^;]*?storedItemValue\(/gs)].length, 0,
    "the same line INSIDE a comment must not count — this codebase explains itself in prose");
});

// ── (7) EVERY CONSUMER REALLY GOES THROUGH THE MODULE ────────────────────────

test("every pre-existing consumer was rewired, not merely joined by a new one", () => {
  // FOUR at the time the extraction was designed — and the divergence gate above
  // found a FIFTH on its first run, web/sceneNav.js's equationBoundCameraProps,
  // whose own docstring had declared the duplication "KNOWN AND TEMPORARY" and
  // named itself the marker for whoever resolved it. That is ledger C-10 exactly:
  // the copies regenerate because the need is real and the shared home is not
  // discoverable from where the author is standing.
  for (const [file, symbol] of [
    ["web/interiorNav.js", "equationBoundInteriorProps"],
    ["web/CanvasToolbar.svelte", "boundKeys"],
    ["web/app.svelte.js", "beginTextEdit"],
    ["web/sceneNav.js", "equationBoundCameraProps"],
  ]) {
    const src = stripComments(readFileSync(resolve(appRoot, file), "utf8"));
    assert.ok(src.includes("equationBoundKeys("), `${file} does not call equationBoundKeys — the ${symbol} rewiring was lost`);
  }
});

// ── (8) THE REFUSAL IS LEGIBLE (todo #240) ───────────────────────────────────
//
// "An equation-bound coordinate silently refuses a drag — no widget says why."
// R6-28 answered that for ONE affordance. `equationLockNote` lived inside
// web/CanvasView.svelte with exactly one caller (the resize-handle probe), so a
// body drag and a yellow square refused in total silence while the same condition
// on a corner explained itself. Two consequences worth stating as measurements
// rather than as prose:
//   · tests/doctest_test.js:629 collects `.js` files ONLY, so the function's two
//     `@example` records had never been executed by anything, in any run. One of
//     them exercised the verb "move" — a code path with NO caller. An example
//     certifying a feature that does not exist is worse than no example.
//   · The sentence is DOMAIN logic (which of this item's leaves are bound), not
//     VIEW logic, which is why it now sits beside the query it is about — the same
//     reason core/commands.js keeps commandUnavailableReason out of the palette.

test("equationLockNote: ONE voice, and it is the voice this condition already had", () => {
  // Word for word the sentence web/app.svelte.js beginTextEdit, web/interiorNav.js
  // and web/CanvasToolbar.svelte already use for the identical condition, plus the
  // clause only a TOGGLE can offer: there is a second way out.
  const one = equationLockNote(["h"], "resize");
  assert.ok(one.includes(`"h" is an = equation`), one);
  assert.ok(one.includes("Edit it in the Inspector"), one);
  assert.ok(one.includes("switch the lock off"), one);
  // PLURAL AGREEMENT IS COMPUTED, not glued on: three separate words change.
  const many = equationLockNote(["x", "w"], "move");
  assert.ok(many.includes(`"x", "w" are = equations`), many);
  assert.ok(many.includes("Edit them in the Inspector"), many);
  // THE VERB IS THE GESTURE'S OWN. The same keys refuse different gestures, so a
  // sentence inferred from the keys alone would name the wrong one half the time.
  assert.ok(equationLockNote(["y"], "move").startsWith("Cannot move:"));
  assert.ok(equationLockNote(["y"], "drag this point").startsWith("Cannot drag this point:"));
});

test("equationLockNote: the sentence names EXACTLY the refused keys, in gesture order", () => {
  // Not "some properties are locked" — the user asked for the LIST, and a
  // paraphrase would be the confident-wrong-answer failure the `requires`-as-a-
  // function ruling exists to prevent.
  const note = equationLockNote(["w", "x"], "resize");
  assert.ok(note.indexOf(`"w"`) < note.indexOf(`"x"`), `order not preserved: ${note}`);
  assert.ok(!note.includes(`"y"`) && !note.includes(`"h"`), `named a key the lock did not refuse: ${note}`);
});

test("translationRecord: the probe and the live drag read the SAME record", () => {
  // The affordance may not rebuild what the gesture asks for — that would be a
  // mirror of translationPairs and would rot against it (ledger C-8). Proven by
  // deriving the gesture's own pairs from the record and comparing.
  const bbox = { itemId: "r", plugin: {}, startX: 10, startY: 20 };
  const { start, desired } = translationRecord(bbox, 5, 3);
  assert.deepEqual(start, { x: 10, y: 20 });
  assert.deepEqual(desired, { x: 15, y: 23 });
  assert.deepEqual(geometryPairs("r", start, desired), translationPairs(bbox, 5, 3));

  // A moveBy widget's record is its PLUGIN's write set, keyed by dotted path.
  const arrow = { itemId: "a", plugin: { moveBy: (raw, dx) => [[["from", "x"], raw.from.x + dx]] }, rawItem: { from: { x: 2 } } };
  const rec = translationRecord(arrow, 5, 0);
  assert.deepEqual(rec, { start: { "from.x": 2 }, desired: { "from.x": 7 } });
  assert.deepEqual(geometryPairs("a", rec.start, rec.desired), translationPairs(arrow, 5, 0));

  // AN EQUATION COORDINATE IS ASKED FOR VERBATIM, which is what makes the body
  // drag's own affordance honest: the record says "y wants 23, x wants its
  // equation back", so refusedCoordinates has something to refuse.
  const bound = translationRecord({ itemId: "r", plugin: {}, startX: "= a.x", startY: 20 }, 5, 3);
  assert.equal(bound.desired.x, "= a.x");
  assert.equal(bound.desired.y, 23);
});

test("the body drag's affordance is derivable AT ALL — a locked x leaves a refused key to name", () => {
  // The mechanism CanvasView.moveAffordance runs, exercised here where a node test
  // can reach it: the record from the live rule, the lock from the document, and
  // refusedCoordinates between them. Without this, "nothing moves and nothing
  // explains" is unfixable, because there is nothing to put in the sentence.
  const app = fakeApp({ x: "= circle.x", y: 20 });
  const lock = equationPinning(app, "r", BOX_PLUGIN);
  const { start, desired } = translationRecord({ itemId: "r", plugin: {}, startX: 100, startY: 20 }, 7, 7);
  assert.deepEqual(refusedCoordinates(lock, start, desired), ["x"]);
  assert.equal(equationLockNote(refusedCoordinates(lock, start, desired), "move"),
    `Cannot move: "x" is an = equation — Equation Lock is on. Edit it in the Inspector, or switch the lock off.`);
  // And the free axis is genuinely still free — the user's own headline example.
  assert.deepEqual(translationPairs({ itemId: "r", plugin: {}, startX: 100, startY: 20 }, 7, 7, lock),
    [[["items", "r", "y"], 27]]);
});

// ── (9) COVERAGE: EVERY REFUSABLE GESTURE HAS A SURFACE THAT SAYS SO ─────────

/**
 * THE ANSWER SHEET, checked for COMPLETENESS against its producer rather than
 * mirroring it. Every key of web/canvas/dragKinds.js DRAG_KIND_MODIFIERS must
 * appear here exactly once, so declaring a new drag kind turns this red until
 * someone answers "and what does it say when the lock refuses it?". That is the
 * shape ledger C-8 prescribes and the shape R6-29's own NOT_PROJECTED table uses:
 * a hardcoded LIST would drift in silence; a hardcoded list whose completeness is
 * derived from the producer cannot.
 *
 * A value is the CanvasView function that produces the sentence, or null with a
 * reason the kind needs none.
 */
const LOCK_SURFACE = {
  move: "moveAffordance",
  resize: "resizeAffordance",
  modifier: "modifierAffordance",
  // A group resizes through the SAME eight handles as a single item — the single
  // selection branch that calls resizeAffordance — so its refusal is already said
  // by that surface rather than by a second one.
  groupresize: "resizeAffordance",
  // OPEN, AND DELIBERATELY NOT FAKED. A multi-resize drives N members that may be
  // locked DIFFERENTLY through one collective box, so "is this handle refused" has
  // no single answer; the collective handles are built without an affordance
  // (web/CanvasView.svelte, the selectedIds.length > 1 branch). Reported rather
  // than answered with a sentence that would be true for one member and wrong for
  // the rest — which is the confident-wrong-answer failure this whole feature's
  // reason-as-a-function ruling exists to prevent.
  multiresize: null,
  // CREATION, not modification: a widget that does not exist yet has no stored
  // leaf to be bound, so there is nothing for the lock to hold.
  place: null,
  placesegment: null,
  // SELECTION, not a write. A band changes what is selected and touches no
  // geometry.
  band: null,
  // WAS R6-29's declared exemption — "the arrow endpoint grab writes outside
  // geometryPairs, so the lock does not reach it and a note here would describe a
  // restriction that is not being imposed" — and that reason was TRUE when it was
  // written and stayed true until the endpoint branch was moved onto the seam.
  //
  // WORTH KEEPING THE HISTORY, because this sheet did its job and the exemption
  // still cost a user a bug report ("when the equation lock is on, why am I able to
  // move the handles of an arrow that has been bound to anchors?"). The entry was
  // honest and complete; what it lacked was any pressure to ever be revisited. A
  // null with a good reason reads as settled, and this one described a CONDITION
  // ("writes outside geometryPairs") that a later commit could falsify silently —
  // nothing failed when the premise changed, because a null entry asserts nothing.
  // So: an exemption justified by a fact about the code should be phrased so the
  // fact is checkable, or it becomes a permanent excuse. This one now isn't one.
  endpoint: "endpointAffordance",
  // NOT A GEOMETRY WRITE — and this is a fact about WHAT the gesture writes, which
  // is the checkable kind of reason the endpoint entry above argues an exemption
  // must have. A wire gesture writes exactly one leaf, `items.<id>.inputs.<port>`
  // (core/nodeflow.connectPairs / disconnectPairs), and it NEVER touches x/y/w/h,
  // rotation or scale. The equation lock exists to stop a DRAG from clobbering a
  // bound coordinate; a connection is not a coordinate and has no equation form to
  // be bound to, so there is no restriction being imposed and therefore no sentence
  // to say. If connections ever become equation-bindable, this entry must become a
  // real affordance — and that change would falsify the premise stated here, in one
  // named function, rather than silently.
  wire: null,
  // WRITES NOTHING AT ALL — the strongest form of the checkable reason the two
  // entries above argue an exemption must have, and easy to falsify if it stops
  // being true. A live play (a Button press, a Keyboard key) produces no
  // setPreview, no commitPreview and no undo unit: the press is routed straight
  // to the audio engine as an EVENT (core/live_control.js), because a moment is
  // not a value any leaf could hold. The equation lock exists to stop a drag from
  // clobbering a BOUND LEAF; this gesture touches no leaf, bound or otherwise, so
  // there is no restriction being imposed and no sentence to say.
  //
  // If a control node ever gains a gesture that WRITES — a knob turn does, but
  // that is knob focus, a canvas MODE rather than a drag kind, and it goes through
  // setPreview like any other property edit — this entry must become a real
  // affordance. That change would falsify the premise stated here rather than
  // silently outliving it.
  liveplay: null,
};

test("COVERAGE: every drag kind is answered — the sheet is complete against DRAG_KINDS", () => {
  assert.deepEqual([...DRAG_KINDS].sort(), Object.keys(LOCK_SURFACE).sort(),
    "a drag kind exists with no entry in LOCK_SURFACE (or vice versa). Adding a kind means answering " +
    "what the canvas says when the equation lock refuses it — name its affordance, or null with a reason.");
});

test("COVERAGE: every named surface EXISTS and reaches the one sentence", () => {
  const canvasView = stripComments(readFileSync(resolve(appRoot, "web/CanvasView.svelte"), "utf8"));
  assert.ok(canvasView.includes(`from "./canvas/equationBinding.js"`),
    "CanvasView no longer imports the shared refusal vocabulary — a local copy of the sentence is the defect this replaced");
  for (const fn of new Set(Object.values(LOCK_SURFACE).filter(Boolean))) {
    assert.ok(new RegExp(`function ${fn}\\b`).test(canvasView), `web/CanvasView.svelte declares no ${fn}`);
    // The function must reach the SHARED sentence, not compose its own.
    const body = canvasView.slice(canvasView.indexOf(`function ${fn}`));
    assert.ok(body.slice(0, body.indexOf("\n  }")).includes("equationLockNote("),
      `${fn} does not call equationLockNote — a second wording of one condition is the Tower of Babel defect`);
  }
});

test("COVERAGE: a computed note that never reaches the markup is the R6-28 defect repeated", () => {
  // MEASURED, not hypothetical. R6-28 computed a per-degree-of-freedom affordance
  // AND added a class directive for the greyed look — with no rule in web/app.css,
  // so the greying rendered nothing and tests/orphan_class_test.js was RED at HEAD.
  // A note nobody can read is the same failure one step earlier, so each surface's
  // output is asserted present in the markup that draws it.
  const canvasView = readFileSync(resolve(appRoot, "web/CanvasView.svelte"), "utf8");
  const resizeHandles = readFileSync(resolve(appRoot, "web/ResizeHandles.svelte"), "utf8");
  assert.ok(/<title>\{h\.lockNote\}<\/title>/.test(resizeHandles), "the resize handle's note is not rendered");
  assert.ok(/<title>\{m\.lockNote\}<\/title>/.test(canvasView), "the modifier point's note is not rendered");
  assert.ok(/<title>\{ep\.lockNote\}<\/title>/.test(canvasView), "the endpoint's note is not rendered");
  assert.ok(/\{#each overlay\.lockTips as t\}/.test(canvasView), "the body drag's note is not rendered");
  assert.ok(/<tspan[^>]*>\{line\}<\/tspan>/.test(canvasView), "the body-drag tip element carries no text");
  assert.ok(canvasView.includes("lockNote.split("), "the body-drag tip no longer derives its lines from the one sentence — a hand-written second wording is the defect this whole section is about");
});

test("COVERAGE: the markup gate can actually fail", () => {
  // The three assertions above are regexes over real files; prove the shape is
  // discriminating rather than matching anything.
  assert.ok(!/<title>\{h\.lockNote\}<\/title>/.test("<rect />"), "the title probe matches markup with no title");
  assert.ok(/<title>\{h\.lockNote\}<\/title>/.test("<rect>{#if h.lockNote}<title>{h.lockNote}</title>{/if}</rect>"));
});

console.log(`\n${passed} equation-lock tests passed over ${roster.length} registered widgets`);
