/**
 * THE INK-BOUNDS REPARAMETRIZATION LAW — the pixel proof.
 * Run: node src/demo_apps/PowerRP/tests/reparametrize_law_test.mjs
 *
 * The user's ruling (2026-08-02, verbatim): "When I do set size to ink bounds, in
 * order to implement that tool, a given widget must also have a way of scaling
 * its content down so that what's visible on the screen does not change. The
 * purpose of this is to make the bounds recognize reality, right? But even if I
 * tween between the two, I should see no difference... it will look like that in
 * the properties, but the thing is that the thing on screen shouldn't move. So
 * this tool only applies to widgets that can somehow scale their interiors
 * separately."
 *
 * So "Set size to ink bounds" is a REPARAMETRIZATION: it changes the numbers in
 * the Inspector and NOTHING ELSE. The contract lives in core/registry.js (THE
 * INK-BOUNDS REPARAMETRIZATION PROTOCOL); this file is the part that can only be
 * settled by rendering, and it checks BOTH halves:
 *
 *   STATIC — the render before and after the fit are byte-identical.
 *   TWEEN  — with the pre-fit state keyframed on slide 1 and the post-fit state
 *            on slide 2, EVERY intermediate alpha renders identically too. This
 *            is the half that catches a compensator which is merely right at the
 *            endpoints, and it is the half the user asked for in as many words.
 *
 * WHY PIXELS AND NOT UNIT ASSERTIONS. The claim is about what is drawn, and the
 * layout that draws it lives behind CanvasKit — a widget can satisfy every
 * arithmetic identity here and still move type by a subpixel. Rendering through
 * cli/render.js is the same display list + paint_skia the editor uses, and it is
 * the path the ink work already measures with. Comparisons are always WITHIN one
 * run against each other, never against a stored golden (the house pattern —
 * tests/imageDistinctness.js records why).
 *
 * EVERY POSITIVE CASE IS PAIRED WITH A NEGATIVE ONE. An identity assertion over a
 * renderer that draws nothing passes vacuously, so each widget also renders a
 * deliberately DIFFERENT document and asserts the shas differ. Without that, a
 * blank canvas would be a green suite.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newDocument, withNewItem, withNewSlide, keyframed, serialize } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";
import { hasInkMeasure } from "../core/ink_metrics.js";
import { plaintextInkBounds, plaintextReparametrizeToBox } from "../plugins/plaintext.js";
import { groupReparametrizeToBox } from "../plugins/group.js";

const W = 640, H = 360;
// The alphas the tween law is checked at. 0 and 1 are the endpoints (which the
// static half already pins); the interior three are the ones a compensator that
// is only endpoint-correct fails at — a mid-tween bulge peaks near 0.5.
const ALPHAS = [0, 0.25, 0.5, 0.75, 1];

const registry = createRegistry();
registerAll(registry, createCommands());
const sha = (b) => createHash("sha256").update(b).digest("hex");

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// WARM THE INK MEASURE BEFORE MEASURING ANYTHING. core/ink_metrics is a seam the
// RENDER side installs (node_render.js does it once CanvasKit's faces are ready),
// so until a render has happened, plaintextInkBounds falls back to the monospace
// ESTIMATE and says so. A fit computed from estimated metrics and then rendered
// with real ones would compare two different rectangles — the suite would still
// go green while measuring the wrong thing, which is exactly the sort of vacuous
// pass this file is built to avoid. So: render once, then REFUSE TO PROCEED
// unless the real measure is in place.
await renderDocToPng(serialize(newDocument()), { slide: 0, alpha: 1, width: 16, height: 16 });
assert.ok(hasInkMeasure(),
  "reparametrize_law: a render completed but core/ink_metrics still has no real text measure installed, so every ink rect below would be a monospace ESTIMATE while the pictures are drawn with real faces. The suite cannot mean anything in that state.");

/** Query. SHA-256 of one (slide, alpha) render of a document. */
async function shaAt(doc, slide, alpha) {
  return sha(await renderDocToPng(serialize(doc), { slide, alpha, width: W, height: H }));
}

/**
 * Query. THE WHOLE LAW for one widget, in one call.
 *
 * Builds the pre-fit document, applies `patchLeaves` as SLIDE-2 KEYFRAMES (which
 * is what the tool's commit does — one delta over the leaves it writes), and
 * proves: the fitted state renders like the original, and so does every alpha of
 * the tween between them.
 *
 * @param {string} label - the case name, for the failure message
 * @param {object} baseState - the item state before the fit
 * @param {object} patchLeaves - flat leaf writes the fit performs (nested one level for `bind`)
 * @returns {Promise<{before: string, after: string}>} the endpoint digests
 */
async function assertLawHolds(label, baseState, patchLeaves, extraItems = []) {
  let doc = newDocument();
  for (const extra of extraItems) [doc] = withNewItem(doc, 0, extra);
  let itemId;
  [doc, itemId] = withNewItem(doc, 0, baseState);
  const before = await shaAt(doc, 0, 1);

  // Slide 2 carries the fit as keyframes — the tween between the slides IS the
  // "even if I tween between the two" the ruling names.
  let two;
  [two] = withNewSlide(doc, 0);
  for (const [key, value] of Object.entries(patchLeaves)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      for (const [sub, leaf] of Object.entries(value)) two = keyframed(two, 1, ["items", itemId, key, sub], leaf);
    else two = keyframed(two, 1, ["items", itemId, key], value);
  }

  const after = await shaAt(two, 1, 1);
  check(before === after, `${label}: STATIC half — the fitted state renders differently from the original (${before} vs ${after}). The tool moved the picture, which is an edit, not a reparametrization.`);

  for (const alpha of ALPHAS) {
    const mid = await shaAt(two, 1, alpha);
    check(mid === before, `${label}: TWEEN half — alpha ${alpha} differs from the static picture (${mid} vs ${before}). The compensator is not the algebraic inverse of the box change: it agrees at the endpoints and drifts in between.`);
  }
  return { before, after };
}

// ── TEXT ─────────────────────────────────────────────────────────────────────
// A caption whose type OVERFLOWS its box downward — the reported defect, and the
// case the tool exists for. Each valign is exercised separately because the
// vertical residue this widget has to absorb is DIFFERENT for each: "top" has
// none, "bottom" happens to have exactly a box's worth, and "middle" has half —
// which is why testing only one of them would have proved nothing about the
// others (measured: naive re-boxing is inert for top/bottom and drifts for
// middle, so the one case that fails is the one a single-case test would miss).
const TEXT_BASE = { ...registry.get("plaintext").defaults, active: true, z: 1, text: "the quick brown fox jumps over the lazy dog", x: 60, y: 50, size: 22, fill: "#e0af68" };

// TWO BOX SHAPES, AND BOTH ARE NECESSARY — this is the mistake this suite made
// first, caught by deliberately breaking the compensator and watching the suite
// stay green:
//   · OVERFLOWING (h far smaller than the type) is the reported defect, but it has
//     NO VERTICAL SLACK, so valignOffset is 0 for every valign and the compensator
//     is never exercised. A suite with only this shape passes with the
//     compensation deleted.
//   · SLACK (h far LARGER than the type) is where the residue lives: "middle"
//     keeps half the slack above the stack and "bottom" keeps all of it, and that
//     offset is inside the ink rect the tool writes as h.
// Both shapes, three valigns, two aligns.
const TEXT_BOXES = {
  overflowing: { w: 240, h: 30 },
  slack: { w: 240, h: 260 },
};

// WHICH STATES ARE EXPECTED TO ACCEPT — and this predicate was WIDENED on
// 2026-08-02 after the user hit the tool's over-refusal (verbatim: "it just has
// to be different from the box in order to use the tool. Getting smaller is a
// legitimate use case too"). It used to read `valign === "top" || shape ===
// "overflowing"`, which refused three families the renderer proves are exact.
//
// The rule that survives measurement: a fit is refused only when it would CHANGE
// a finite box height under a valign that REDISTRIBUTES slack. That is "middle"
// with real slack, and nothing else:
//   · "top" never redistributes — the stack hangs from the top edge.
//   · "bottom" WITH slack has ink.h == box.h identically (its rect spans from the
//     box top to the type's bottom, so vOffset + stackHeight == boxH). The fit is
//     a NO-OP on h, and a no-op cannot move type. Measured across every text
//     length and box height tried; asserted directly below as BOTTOM_FIT_IS_NOOP.
//   · an OVERFLOWING box has no slack for any valign.
const expectsAccept = (shape, valign) => valign !== "middle" || shape === "overflowing";

for (const [shape, box] of Object.entries(TEXT_BOXES)) {
  for (const valign of ["top", "middle", "bottom"]) {
    for (const align of ["left", "center"]) {
      const state = { ...TEXT_BASE, ...box, valign, align };
      const ink = plaintextInkBounds(state);
      const patch = plaintextReparametrizeToBox(state, { x: state.x, y: state.y, w: ink.w, h: ink.h });
      const label = `plaintext ${shape} ${valign}/${align}`;
      if (expectsAccept(shape, valign)) {
        check(patch !== null, `${label}: the widget REFUSED a fit it should accept — the type hangs from the box's top edge here, so the re-box cannot move it.`);
        if (patch) await assertLawHolds(label, state, patch);
      } else {
        check(patch === null, `${label}: the widget ACCEPTED a fit it cannot honour. A box taller than its type carries a valign residue that plaintextReparametrizeToBox has no way to measure (the ink rect and the renderer use two different layout engines) — accepting it moves the type.`);
      }
    }
  }
}

// ── SHRINK: THE NEWLY ACCEPTED FAMILIES (user ruling, 2026-08-02) ─────────────
// "Getting smaller is a legitimate use case too". Each family below was REFUSED
// before this wave and is byte-identical at every alpha; the law harness is the
// evidence, so a future re-tightening has to face it.

// WHY "bottom" IS SAFE, stated as arithmetic rather than left to the pixels: its
// ink rect always spans the whole box, so the fit never changes h at all. If this
// ever stops holding, the acceptance above is no longer justified by "it is a
// no-op" and must be re-measured rather than assumed.
{
  const state = { ...TEXT_BASE, ...TEXT_BOXES.slack, valign: "bottom", align: "left" };
  const ink = plaintextInkBounds(state);
  check(Math.abs(ink.h - state.h) < 1e-9,
    `BOTTOM_FIT_IS_NOOP: a bottom-valign box's ink height (${ink.h}) is supposed to equal its box height (${state.h}) — that identity is WHY the slack/bottom case is accepted. It no longer holds, so the fit now changes h under a redistributing valign and the acceptance needs re-measuring.`);
}

// SHRINK FAMILY 1 — NO VERTICAL BOX (h absent/0). Every non-top valign used to
// refuse here because the guard compared against an Infinite box height, yet a
// box with no height has no slack to redistribute.
for (const valign of ["middle", "bottom"]) {
  for (const align of ["left", "center"]) {
    const state = { ...TEXT_BASE, w: 240, h: 0, valign, align };
    const ink = plaintextInkBounds(state);
    const label = `plaintext shrink h=0 ${valign}/${align}`;
    const patch = plaintextReparametrizeToBox(state, { x: state.x, y: state.y, w: ink.w, h: ink.h });
    check(patch !== null, `${label}: refused a fit with NO vertical box — there is no slack to redistribute when the box has no height, so this must accept.`);
    if (patch) await assertLawHolds(label, state, { ...patch, w: ink.w, h: ink.h });
  }
}

// SHRINK FAMILY 2 — ZERO SLACK under a non-top valign. The old guard compared the
// box against the TOP-valign ink height, the wrong reference for middle/bottom,
// so a box exactly as tall as its type refused.
{
  const stackH = plaintextInkBounds({ ...TEXT_BASE, w: 240, h: 0, valign: "top" }).h;
  for (const valign of ["middle", "bottom"]) {
    for (const align of ["left", "center"]) {
      const state = { ...TEXT_BASE, w: 240, h: stackH, valign, align };
      const ink = plaintextInkBounds(state);
      const label = `plaintext shrink zero-slack ${valign}/${align}`;
      const patch = plaintextReparametrizeToBox(state, { x: state.x, y: state.y, w: ink.w, h: ink.h });
      check(patch !== null, `${label}: refused a fit on a box exactly as tall as its type — there is no slack, so valign has nothing to redistribute and the re-box cannot move the glyphs.`);
      if (patch) await assertLawHolds(label, state, { ...patch, w: ink.w, h: ink.h });
    }
  }
}

// THE REFUSAL IS NOT PRECAUTIONARY — the drift it avoids is DEMONSTRATED. Naively
// fitting a slack middle-aligned box must render differently from the original;
// if it ever stops doing so, the two layout engines have converged and the
// refusal above can be replaced by the compensator its docblock describes.
{
  const state = { ...TEXT_BASE, ...TEXT_BOXES.slack, valign: "middle", align: "center" };
  const ink = plaintextInkBounds(state);
  const before = await shaAt(withOne(state), 0, 1);
  const naive = await shaAt(withOne({ ...state, w: ink.w, h: ink.h }), 0, 1);
  check(naive !== before,
    "plaintext: the NAIVE re-box of a slack middle-aligned box rendered IDENTICALLY, so the valign residue this widget refuses over no longer exists. Re-check the two layout engines (core/richtext vs render_gpu/skia/text_layout) — if they now agree, plaintextReparametrizeToBox should compensate and accept instead of refusing.");
}

// THE NEGATIVE CONTROL for text: the renders above must not all be the same
// blank picture. A left/top caption and a centre/middle one are genuinely
// different images, so if these two agree the harness is drawing nothing and
// every identity above is vacuous.
{
  const a = await shaAt(withOne({ ...TEXT_BASE, valign: "top", align: "left" }), 0, 1);
  const b = await shaAt(withOne({ ...TEXT_BASE, valign: "middle", align: "center" }), 0, 1);
  check(a !== b, "plaintext NEGATIVE CONTROL: a top/left caption rendered byte-identically to a middle/centre one, so the text is not reaching the canvas at all and every identity above passes vacuously.");
}

// REFUSAL: an unbreakable word overruns its wrap box, so the ink is WIDER than
// the box. Accepting would widen the wrap and the lines would re-flow — a real
// reflow no offset undoes. Pinned as a refusal so a future "improvement" that
// starts accepting it has to face this measurement.
{
  const narrow = { ...TEXT_BASE, text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa", w: 100, h: 40, valign: "top" };
  const ink = plaintextInkBounds(narrow);
  check(ink.w > (narrow.w ?? 0), `plaintext refusal setup: the ink (${ink.w}) should overrun the wrap box (${narrow.w}) for this case to mean anything.`);
  check(plaintextReparametrizeToBox(narrow, { x: narrow.x, y: narrow.y, w: ink.w, h: ink.h }) === null,
    "plaintext: a fit that WIDENS the wrap box must be refused — widening re-flows the line breaks, which no interior offset can compensate.");
}

// An EMPTY box has no ink and refuses (there is nothing to fit to).
check(plaintextReparametrizeToBox({ text: "", w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 }) === null,
  "plaintext: an empty box must refuse — it draws nothing, so there is no ink to make the box agree with.");

// ── GROUP ────────────────────────────────────────────────────────────────────
// Two rects with a collective hull of (100,80)-(340,260), inside a group boxed
// deliberately larger. The fit shrinks the group to the hull and re-binds.
const MEMBER_A = { ...registry.get("rect").defaults, x: 100, y: 80, w: 100, h: 100, fill: "#e0af68", strokeWidth: 0, active: true, z: 1 };
const MEMBER_B = { ...registry.get("rect").defaults, x: 240, y: 160, w: 100, h: 100, fill: "#7dcfff", strokeWidth: 0, active: true, z: 2 };

/**
 * Query. A group document whose members are the two rects above. Returns the
 * doc plus the group's itemId so a caller can keyframe the fit onto slide 2.
 */
function groupDoc(groupOverrides) {
  let doc = newDocument(), ids = [];
  for (const m of [MEMBER_A, MEMBER_B]) {
    let id; [doc, id] = withNewItem(doc, 0, m); ids.push(id);
  }
  let gid;
  [doc, gid] = withNewItem(doc, 0, {
    ...registry.get("group").defaults, active: true, z: 5, members: ids,
    x: 40, y: 20, w: 400, h: 320, rotation: 0, scale: 1,
    bind: { x: 40, y: 20, rotation: 0, scale: 1 },
    ...groupOverrides,
  });
  return [doc, gid];
}

/** Query. A one-item document (the text negative control's helper). */
function withOne(state) {
  const [doc] = withNewItem(newDocument(), 0, state);
  return doc;
}

// The members' hull in the group's own local frame (group at 40,20, unrotated,
// unscaled ⇒ local = world − (40,20)); the box the fit would write.
const HULL_BOX = { x: 40 + 60, y: 20 + 60, w: 240, h: 180 };

{
  const [doc, gid] = groupDoc({});
  const state = { x: 40, y: 20, w: 400, h: 320, rotation: 0, scale: 1, bind: { x: 40, y: 20, rotation: 0, scale: 1 } };
  const patch = groupReparametrizeToBox(state, HULL_BOX);
  check(patch !== null, "group: a plain (uncropped, effect-free) group must ACCEPT the reparametrization — a bind rewrite makes it exact.");

  // Re-run the whole law with the group's own document (two members + the group).
  let base = doc;
  const before = await shaAt(base, 0, 1);
  let two; [two] = withNewSlide(base, 0);
  for (const [key, value] of Object.entries({ ...HULL_BOX, ...patch })) {
    if (value !== null && typeof value === "object")
      for (const [sub, leaf] of Object.entries(value)) two = keyframed(two, 1, ["items", gid, key, sub], leaf);
    else two = keyframed(two, 1, ["items", gid, key], value);
  }
  const after = await shaAt(two, 1, 1);
  check(before === after, `group: STATIC half — re-boxing the group moved its members (${before} vs ${after}). The bind rewrite is supposed to make the new pose identity influence.`);
  for (const alpha of ALPHAS) {
    const mid = await shaAt(two, 1, alpha);
    check(mid === before, `group: TWEEN half — alpha ${alpha} differs (${mid} vs ${before}). bind.{x,y} must lerp in lockstep with x/y, or the group drags its members mid-transition and snaps back at the end.`);
  }

  // NEGATIVE CONTROL: re-boxing WITHOUT the bind rewrite must visibly move the
  // members. Without this, the identity above would also pass on a build where
  // the group influenced nothing at all.
  let noBind; [noBind] = withNewSlide(base, 0);
  for (const [key, value] of Object.entries(HULL_BOX)) noBind = keyframed(noBind, 1, ["items", gid, key], value);
  const unbound = await shaAt(noBind, 1, 1);
  check(unbound !== before, "group NEGATIVE CONTROL: re-boxing WITHOUT the bind rewrite rendered identically, so the group is not influencing its members and the bind-rewrite identity above is vacuous.");
}

// A CROPPED group REFUSES: groupCropRect trims the group's own [0,0,w,h], so the
// clip is defined in the very box being replaced. Measured both ways — the
// refusal is asserted AND the drift it protects against is demonstrated, so this
// cannot decay into an unfalsifiable "we just don't do that".
{
  const crop = { cropLeft: 30, cropTop: 20, cropRight: 30, cropBottom: 20 };
  check(groupReparametrizeToBox({ x: 40, y: 20, w: 400, h: 320, ...crop }, HULL_BOX) === null,
    "group: a CROPPED group must refuse — its crop insets are measured against the box being replaced, so re-boxing moves the clip.");

  const [doc, gid] = groupDoc(crop);
  const before = await shaAt(doc, 0, 1);
  let two; [two] = withNewSlide(doc, 0);
  for (const [key, value] of Object.entries({ ...HULL_BOX, bind: { x: HULL_BOX.x, y: HULL_BOX.y, rotation: 0, scale: 1 } })) {
    if (value !== null && typeof value === "object")
      for (const [sub, leaf] of Object.entries(value)) two = keyframed(two, 1, ["items", gid, key, sub], leaf);
    else two = keyframed(two, 1, ["items", gid, key], value);
  }
  const cropped = await shaAt(two, 1, 1);
  check(cropped !== before, "group: the CROPPED case is supposed to DRIFT when re-boxed (that is why it refuses) — it rendered identically instead, so either the crop is not rendering or the refusal is now unnecessary. Re-measure before relaxing it.");
}

// GROUP SHRINK IS THE CASE ABOVE (the box is 400x320 and the hull 240x180, so the
// fit SHRINKS it) — recorded here because the user's report was about shrinking
// and "the group path already handles it" is the sort of claim that should be
// pinned rather than asserted. The complementary direction: a group boxed SMALLER
// than its members' hull grows to it, through the same bind rewrite.
{
  const [doc, gid] = groupDoc({ x: 140, y: 120, w: 80, h: 60, bind: { x: 140, y: 120, rotation: 0, scale: 1 } });
  const patch = groupReparametrizeToBox({ x: 140, y: 120, w: 80, h: 60, rotation: 0, scale: 1 }, HULL_BOX);
  check(patch !== null, "group GROW: a group boxed smaller than its members' hull must accept — the bind rewrite is direction-agnostic.");
  const before = await shaAt(doc, 0, 1);
  let two; [two] = withNewSlide(doc, 0);
  for (const [key, value] of Object.entries({ ...HULL_BOX, ...patch })) {
    if (value !== null && typeof value === "object")
      for (const [sub, leaf] of Object.entries(value)) two = keyframed(two, 1, ["items", gid, key, sub], leaf);
    else two = keyframed(two, 1, ["items", gid, key], value);
  }
  for (const alpha of ALPHAS) {
    const mid = await shaAt(two, 1, alpha);
    check(mid === before, `group GROW: alpha ${alpha} differs (${mid} vs ${before}) — growing a group's box to its members' hull must be as inert as shrinking it.`);
  }
}

// ── THE REFUSERS: every registered widget either accepts or is absent ─────────
// Not a list of names (which rots as widgets are added) but a sweep: whatever
// declares the hook must return an object or null for a plausible box, and
// whatever does not declare it refuses by default. This is what keeps "refusal is
// the default" true rather than aspirational.
{
  const declared = registry.all().filter((p) => typeof p.reparametrizeToBox === "function").map((p) => p.type);
  check(declared.includes("plaintext") && declared.includes("group"),
    `the two widgets this wave gave the capability to must declare it; got [${declared.join(", ")}].`);
  // The content-stretched widgets, named explicitly because these are the ones a
  // well-meaning future change is most likely to "enable" — each fits its raster
  // or vector to [0,0,w,h], so a re-box RESCALES the picture.
  const registered = new Set(registry.all().map((p) => p.type));
  for (const type of ["latex", "image", "svg", "mermaid", "pdf_page", "video"]) {
    if (!registered.has(type)) continue;
    check(typeof registry.get(type).reparametrizeToBox !== "function",
      `${type} declares reparametrizeToBox — it is content-stretched (its picture is sized BY its box), so it must refuse until it carries an interior scale the patch can invert. See THE REFUSERS in core/registry.js.`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} failure(s) — the ink-bounds reparametrization law is violated.`);
  process.exit(1);
}
console.log(`reparametrize_law: OK — static + tween identity at alphas [${ALPHAS.join(", ")}] for plaintext (3 valigns x 2 aligns), the SHRINK families (no-vertical-box + zero-slack, 2 valigns x 2 aligns each), and group in BOTH directions, with negative controls; refusals pinned for wrap-reflow text, empty text, slack+middle text, and cropped groups.`);
