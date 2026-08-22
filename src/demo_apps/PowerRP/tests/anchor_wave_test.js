/**
 * THE ANCHOR-BIND HYSTERESIS AND THE CREATION-TIME BIND — plain node, no
 * framework (suite convention).
 * Run: node src/demo_apps/PowerRP/tests/anchor_wave_test.js
 *
 * TWO USER REPORTS, one seam.
 *
 * [AI] "Dragging an arrow onto an anchor … while dragging, it flickers - when the
 * mouse moves 1px it keeps flipping between anchored and not anchored -
 * particularly when equation lock is turned on."
 *   web/CanvasView.svelte endpointDrag re-decides the bind from raw pointer state
 *   on EVERY move against ONE hard threshold (SNAP_PX / zoom). A pointer resting
 *   AT that threshold therefore toggles bound/unbound with every jitter — and
 *   under the equation lock each toggle also runs the refusal path, so the cursor
 *   and the refusal sentence churn per pixel too. The fix is core/snap.js
 *   stickyAnchorCandidate: the same hysteresis shape axisLock already uses for the
 *   same class of held decision.
 *
 * [AJ] "when anchors are enabled, there's no way to choose anchor positions when
 * DRAWING an arrow i always seem to have to draw it THEN move it to the anchors."
 *   Creation placement snapped GEOMETRICALLY (snapPoint) and stopped there, so a
 *   drawn arrow LANDED on an anchor as a plain number and did not follow it.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. The decision itself
 * is a PURE function and is tested directly and exhaustively (§1-§3) — that is the
 * whole reason it was extracted out of the Svelte component. The WIRING into
 * CanvasView is not something node can execute (it is a .svelte file with a
 * browser-only import graph), so it is asserted by READING THE SOURCE for the
 * exact call shapes (§4) — the tests/anchor_snap_release_test.js precedent,
 * written there because a hand-built imitation of a call path is what let a
 * shipped crash stay green. A source assertion cannot prove the gesture feels
 * right; it proves the pure rule is REACHED, which is precisely the half that was
 * missing (endpointDrag had no hysteresis of any kind, and placementUp had no
 * bind path at all).
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stickyAnchorCandidate, axisLock } from "../core/snap.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANVAS_VIEW = fs.readFileSync(path.join(HERE, "..", "web", "CanvasView.svelte"), "utf8");
const CREATION_STEPS = fs.readFileSync(path.join(HERE, "..", "web", "creationSteps.js"), "utf8");

/** The tolerance every case below is stated against: SNAP_PX (8) at zoom 1. */
const TOL = 8;

// ── §1. THE FLICKER CASE ITSELF, BOTH DIRECTIONS ─────────────────────────────

test("1a. a pointer jittering 1px ACROSS the tolerance stays BOUND — the reported defect", () => {
  // The exact gesture the user describes: the endpoint is resting on an anchor at
  // the tolerance and the hand shakes. Under the OLD rule (`d <= tol`) this
  // sequence alternates bound/unbound/bound/unbound with every sample.
  const jitter = [7.5, 8.5, 7.6, 8.4, 8.1, 7.9, 8.6, 7.4];
  let incumbent = null;
  const decisions = [];
  for (const d of jitter) {
    const pick = stickyAnchorCandidate([{ id: "a:pt", d }], incumbent, TOL);
    incumbent = pick?.id ?? null;
    decisions.push(incumbent);
  }
  assert.deepEqual(
    decisions,
    ["a:pt", "a:pt", "a:pt", "a:pt", "a:pt", "a:pt", "a:pt", "a:pt"],
    "a 1px jitter around the tolerance must not toggle the binding — this is the AI defect",
  );
  // And the old rule really did flicker, so the case above is not vacuous.
  const oldRule = jitter.map((d) => (d <= TOL ? "a:pt" : null));
  assert.notDeepEqual(oldRule, decisions, "the pre-fix rule must disagree here, or this test proves nothing");
  assert.equal(new Set(oldRule).size, 2, "the pre-fix rule flip-flops (both outcomes appear across the jitter)");
});

test("1b. the OTHER direction: jitter around the tolerance while UNBOUND does not flicker into a bind", () => {
  // Symmetry matters: a hysteresis that only sticks one way replaces a flicker
  // with a latch. Approaching from outside, the FIRST crossing of the plain
  // tolerance binds (that is how you ever bind at all), and it then stays bound —
  // there is no sample that binds, unbinds and rebinds.
  const approach = [12, 10, 8.5, 8.05, 7.99, 8.3, 8.9];
  let incumbent = null;
  const decisions = [];
  for (const d of approach) {
    const pick = stickyAnchorCandidate([{ id: "a:pt", d }], incumbent, TOL);
    incumbent = pick?.id ?? null;
    decisions.push(incumbent);
  }
  assert.deepEqual(decisions, [null, null, null, null, "a:pt", "a:pt", "a:pt"]);
  const flips = decisions.filter((d, i) => i > 0 && d !== decisions[i - 1]).length;
  assert.equal(flips, 1, "exactly one transition across the whole approach — no flicker in either direction");
});

test("1c. a genuine drag AWAY still releases, and the sticky band is finite", () => {
  // The user's other rule must survive the fix: "dragging past it DETACHES the
  // endpoint back to plain numbers". Stickiness widens the release threshold; it
  // must not remove it.
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: 11.9 }], "a:pt", TOL)?.id, "a:pt", "inside 8*1.5 — still held");
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: 12.1 }], "a:pt", TOL), null, "past 8*1.5 — genuinely released");
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: 400 }], "a:pt", TOL), null, "far away — released");
});

// ── §2. THE SECOND FLICKER SHAPE: TWO RIVAL ANCHORS ──────────────────────────

test("2a. a rival anchor must BEAT the incumbent by a margin, not by 0.1px", () => {
  // Two anchors a hair apart (a stacked pair, or a bbox corner and a widget's own
  // point at nearly the same spot) trade the binding on sub-pixel noise if any
  // improvement wins. Same defect one level down.
  const noise = [
    [{ id: "a:pt", d: 5.0 }, { id: "b:pt", d: 4.9 }],
    [{ id: "a:pt", d: 4.9 }, { id: "b:pt", d: 5.0 }],
    [{ id: "a:pt", d: 5.1 }, { id: "b:pt", d: 4.8 }],
  ];
  let incumbent = "a:pt";
  for (const cands of noise) {
    incumbent = stickyAnchorCandidate(cands, incumbent, TOL)?.id ?? null;
    assert.equal(incumbent, "a:pt", "a rival within noise of the incumbent must not steal it");
  }
});

test("2b. a rival that is CLEARLY closer does steal — stickiness is not a latch", () => {
  const pick = stickyAnchorCandidate([{ id: "a:pt", d: 6 }, { id: "b:pt", d: 2 }], "a:pt", TOL);
  assert.equal(pick.id, "b:pt", "2 is well under 75% of 6 — the author moved to a different anchor");
});

test("2c. with NO incumbent the rule is plain nearest-within-tolerance (first move of a gesture)", () => {
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: 6 }, { id: "b:pt", d: 5.9 }], null, TOL).id, "b:pt");
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: 9 }, { id: "b:pt", d: 20 }], null, TOL), null, "nothing in tolerance");
  assert.equal(stickyAnchorCandidate([], null, TOL), null, "nothing at all");
});

test("2d. an incumbent that VANISHED from the field (item purged mid-drag) is not resurrected", () => {
  // The incumbent is looked up IN the candidate list, so a purged target cannot
  // keep a binding alive by id alone.
  assert.equal(stickyAnchorCandidate([{ id: "b:pt", d: 3 }], "a:pt", TOL).id, "b:pt");
  assert.equal(stickyAnchorCandidate([], "a:pt", TOL), null);
});

// ── §3. THE HYSTERESIS IS THE HOUSE ONE, NOT AN INVENTED NUMBER ──────────────

test("3. the stickiness matches axisLock's precedent (1.5), measured through both functions", () => {
  // Neither constant is exported; both are asserted through the behaviour they
  // define, so a change to either is visible here rather than only in a comment.
  // axisLock: the other axis must exceed 1.5x to steal.
  assert.equal(axisLock(10, 14.9, "x"), "x");
  assert.equal(axisLock(10, 15.1, "x"), "y");
  // stickyAnchorCandidate: the incumbent survives to exactly 1.5x the tolerance.
  assert.ok(stickyAnchorCandidate([{ id: "a:pt", d: TOL * 1.49 }], "a:pt", TOL));
  assert.equal(stickyAnchorCandidate([{ id: "a:pt", d: TOL * 1.51 }], "a:pt", TOL), null);
});

// ── §4. THE WIRING (source assertions — see the header for why) ──────────────

test("4a. endpointDrag routes its bind decision through stickyAnchorCandidate", () => {
  assert.match(CANVAS_VIEW, /import \{[^}]*\bstickyAnchorCandidate\b[^}]*\} from "\.\.\/core\/snap\.js"/,
    "CanvasView must import the pure rule");
  const body = CANVAS_VIEW.slice(CANVAS_VIEW.indexOf("function endpointDrag("));
  const end = body.indexOf("\n  function ", 1);
  const endpointDrag = body.slice(0, end === -1 ? body.length : end);
  assert.match(endpointDrag, /stickyAnchorCandidate\(/, "endpointDrag must ASK the rule, not re-decide inline");
  assert.match(endpointDrag, /drag\.boundAnchorId/,
    "the incumbent must live on the DRAG record — a module-level one would leak between gestures");
  assert.doesNotMatch(endpointDrag, /d <= tol && \(!best \|\| d < best\.d\)/,
    "the old single-threshold nearest-wins loop must be gone, not merely bypassed");
});

test("4b. creation placement BINDS: the segment grammar writes anchor equations at release", () => {
  assert.match(CANVAS_VIEW, /function placementAnchorBind\(/, "the creation bind seam must exist");
  assert.match(CANVAS_VIEW, /stickyAnchorCandidate\(anchorBindCandidates\(app\.nodes\(\), w, tol\), drag\[key\]/,
    "creation must use the SAME sticky rule and the SAME candidate search as the endpoint drag");
  // The commit must actually consult the picks — a bind that is decided and then
  // dropped on release is the defect with extra steps.
  const up = CANVAS_VIEW.slice(CANVAS_VIEW.indexOf("function placementUp("));
  const upBody = up.slice(0, up.indexOf("\n  function ", 1));
  assert.match(upBody, /endpointWithBinds\(/, "placementUp must rewrite the bound ends as equations");
  assert.match(upBody, /drag\.fromPick|drag\.livePick/, "placementUp must read the picks the gesture stashed");
});

test("4c. the bind is GATED on the anchors toggle, matching endpointDrag (the stated choice)", () => {
  // The brief required this decision to be made and SAID: creation binds when
  // anchors are VISIBLE, with no modifier — the same gate endpointDrag uses,
  // because creation is the drawing half of that same gesture. It deliberately
  // does NOT follow move/resize's `aHeld`. Asserted so a later change to either
  // half cannot silently make the two gestures disagree about what a drop does.
  const fn = CANVAS_VIEW.slice(CANVAS_VIEW.indexOf("function placementAnchorBind("));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /app\.anchorsVisible/, "gated on the anchors toggle");
  assert.doesNotMatch(body, /\baHeld\b/, "NOT gated on the A modifier — that is the move/resize story");
});

test("4d. both gestures write the SAME equation shape", () => {
  // One string form, produced in one helper, consumed by both — so an arrow drawn
  // onto an anchor and one dragged onto it are the same document.
  const helper = CANVAS_VIEW.slice(CANVAS_VIEW.indexOf("function applyAnchorBind("));
  assert.match(helper.slice(0, 600), /`@\$\{pick\.itemId\}_\$\{pick\.anchorId\}\.x`/);
  const eq = CANVAS_VIEW.slice(CANVAS_VIEW.indexOf("function endpointWithBinds("));
  assert.match(eq.slice(0, 600), /`@\$\{pick\.itemId\}_\$\{pick\.anchorId\}\.x`/);
});

test("4e. a BOX placement gets no per-end bind, and says so", () => {
  // A rect has four corners and no per-end identity, so there is no single
  // coordinate pair an equation could name. Pinned because the tempting
  // generalisation ("bind every placement") would write nonsense for a box.
  assert.match(CANVAS_VIEW, /drag\.kind === "placesegment" \? placementAnchorBind/,
    "the bind must be gated to the segment grammar");
});

test("4f. the creationSteps docstring no longer claims a binding it does not perform", () => {
  // It said a snapped vertex "lands on another widget's anchor", which reads as
  // the binding and was coincidence. Fixed in the same commit as the feature so
  // the file does not describe a neighbouring behaviour it lacks.
  const payload = CREATION_STEPS.slice(CREATION_STEPS.indexOf("The ONE pointer payload"));
  const doc = payload.slice(0, payload.indexOf("*/"));
  assert.doesNotMatch(doc, /lands on another widget's anchor like every other placement does\)/,
    "the overstating sentence must be gone");
  assert.match(doc, /GEOMETRICALLY/, "it must now say the correction is geometric");
  assert.match(doc, /not a binding/i, "and say explicitly that it is not a binding");
});
