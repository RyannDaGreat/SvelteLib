/**
 * Group widget — the FIRST real parent-widget instance (manifest "GROUPS",
 * "Widget composition bound": the armature-shaped derivation API). A group is a
 * widget whose SOLE purpose is controlling OTHER widgets: it has a bounding box
 * (move/scale/rotate the group ⇒ its members move/scale/rotate) and renders
 * NOTHING of its own. Members stay STORED, independently-derived items — the
 * group's influence is composed onto their world transforms in the derivation
 * stage (core/derive.js applyGroupParenting), never baked into their state, so
 * a member can still be moved individually and the group's influence composes
 * on top. THE core invariant holds: RenderTree = pure(document, alphas).
 *
 * STATE:
 *   members: [itemId]                 — the controlled items.
 *   bind: {x, y, rotation, scale}     — the group's BIND POSE, captured at
 *     creation (Group Selection): the reference against which the group's
 *     CURRENT transform is measured to derive its influence (manifest "Bind
 *     state (ground-zero stack)"). Influence = current ∘ invert(bind), so a
 *     group at its bind pose moves nothing (re-pose invariance).
 *   x/y/w/h/rotation/scale            — the group's own similarity + bbox
 *     (the collective AABB of the selection at creation time).
 *
 * GHOST: a group has no rendered volume, so it is a GHOST (capabilities.ghost;
 * manifest ARCHITECTURE PLAN #2) — its faint outline draws under the "Show
 * Ghosts" toolbar toggle (the manifest's "Show Groups" mechanism rides the
 * ghost mechanism), and clicking that outline selects the group (border-only
 * hitTest, the camera precedent: interior clicks fall through to members).
 *
 * SUBTREE EFFECTS (the subtree-effects gap): a group is normally a pure ghost,
 * but when it carries an ACTIVE effects bundle (shadow/bloom/blend/inner-shadow)
 * or a CROP (the cropInsets bundle) it becomes a COMPOSITING SUBTREE — its whole
 * member subtree renders into one texture and the effect/crop/blend applies to
 * that composite (a drop shadow cast by the group silhouette; a blend mode
 * compositing the group against the backdrop; a crop clipping the whole group).
 * This reuses the SAME machinery a single vector object uses (render_gpu/effects.
 * applyEffects → ONE effectSubtree, and cropSubtree): derive.js
 * (resolveGroupSubtrees) folds the members + records draw order, sceneIR builds
 * their subtree IR and hands it to emit() (the cropbox targetWorldIR precedent),
 * and emit() nests it in the effect/crop op. Members stay first-class for
 * hit-testing/anchors/snap — only the render walk folds them. An effect-free,
 * uncropped group is byte-identical to before (groupFoldsSubtree → false).
 *
 * This file owns ONLY the group's own widget definition. Grouping/ungrouping
 * commands (which need the selection + collective AABB + keyframe baking) live
 * in web/app.svelte.js (groupSelection / ungroupSelection) — the crop-box
 * precedent where cross-item orchestration lives in the app, not the plugin.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { borderBandHit } from "../core/geometry.js";
import { bundle, bundleDefaults, bundleNestedDefaults } from "../core/properties.js";
import * as T from "../core/transform.js";
import { cropSubtree } from "../render_gpu/ir.js";
import { applyEffects, effectsOff, effectsCullMargin } from "../render_gpu/effects.js";

/**
 * Pure function. A group's LOCAL-space CROP rect (the cropInsets bundle), or null
 * when it crops nothing. The per-edge insets (cropTop/cropLeft/cropRight/
 * cropBottom, canvas units — core/properties.js) trim the group's OWN bbox
 * [0,0,w,h] to an inner rectangle that CLIPS the whole member composite (the
 * subtree crop). Null when every inset is 0, so an uncropped group is
 * byte-identical to before (the emit skips the clip entirely).
 *
 * @param {object} s - evaluated group state (w/h + cropTop/Left/Right/Bottom)
 * @returns {{x: number, y: number, w: number, h: number}|null}
 *
 * @example groupCropRect({w: 200, h: 100}) // null (no insets)
 * @example groupCropRect({w: 200, h: 100, cropLeft: 20, cropRight: 30}) // {x: 20, y: 0, w: 150, h: 100}
 * @example groupCropRect({w: 200, h: 100, cropTop: 10, cropBottom: 10}) // {x: 0, y: 10, w: 200, h: 80}
 */
export function groupCropRect(s) {
  const l = Math.max(0, s.cropLeft ?? 0), t = Math.max(0, s.cropTop ?? 0);
  const r = Math.max(0, s.cropRight ?? 0), b = Math.max(0, s.cropBottom ?? 0);
  if (l === 0 && t === 0 && r === 0 && b === 0) return null;
  return { x: l, y: t, w: Math.max(0, (s.w ?? 0) - l - r), h: Math.max(0, (s.h ?? 0) - t - b) };
}

/**
 * Pure function. Does this group FOLD its member subtree into one composited
 * unit (the subtree-effects gap)? True iff it carries an ACTIVE effects bundle
 * (shadow/bloom/blend/inner-shadow — render_gpu/effects.effectsOff) OR a crop
 * (groupCropRect). When true, core/derive.resolveGroupSubtrees folds the members
 * and the group emits ONE effectSubtree/cropSubtree wrapping them; when false the
 * group stays a pure ghost and its members render independently (byte-identical
 * to before this feature).
 *
 * @param {object} s - evaluated group state
 * @returns {boolean}
 *
 * @example groupFoldsSubtree({}) // false (no effects, no crop → pure ghost)
 * @example groupFoldsSubtree({blendMode: "multiply"}) // true (blend wraps the whole group)
 * @example groupFoldsSubtree({shadow: {opacity: 0.5, blur: 6}}) // true (shadow cast by the group silhouette)
 * @example groupFoldsSubtree({w: 200, h: 100, cropRight: 40}) // true (crop clips the whole group)
 */
export function groupFoldsSubtree(s) {
  return groupCropRect(s) !== null || !effectsOff(s);
}

/**
 * Pure function. THE REPARAMETRIZATION PROTOCOL for a group (the contract lives
 * in core/registry.js: "Set Size to Ink Bounds" must change the numbers and NOT
 * the picture, at every tween alpha as well as at the endpoints). Returns the
 * interior compensation a re-box costs, or null to refuse.
 *
 * A GROUP IS THE MODEL CASE, and it is the model case for a reason worth stating:
 * a plain group DRAWS NOTHING OF ITS OWN (emit() → [], the pure ghost), so its
 * box cannot possibly be visible. What its box DOES do is serve as the reference
 * for its influence on its members — influence = current ∘ invert(bind) — and
 * that is why the compensator is a BIND REWRITE rather than nothing at all.
 * Re-boxing without re-binding would make the new pose read as a transformation
 * OF the members and shove them across the slide; re-binding at the new pose
 * restores identity influence, which is exactly the user's "like I ungrouped them
 * and then regrouped them again".
 *
 * IT IS LINEAR IN THE LERPED PARAMETERS, which is what satisfies the TWEEN half
 * of the law and not merely the static half. bind.{x,y} are set equal to the new
 * {x,y}, so a delta tween lerping x from x₀ to x₁ lerps bind.x identically —
 * current ∘ invert(bind) stays the identity at EVERY alpha, not just at 0 and 1.
 * (bind.rotation/scale are carried through unchanged for the same reason: the
 * tool never touches them, so pinning them to their current values keeps the pair
 * consistent if a rotated group is fitted.)
 *
 * A CROPPED GROUP REFUSES, and this is measured rather than assumed
 * (tests/reparametrize_law_test.mjs renders both). groupCropRect trims the
 * group's OWN [0,0,w,h] by the four insets, so the clip is defined IN the box
 * being replaced: shrink the box and the members get cut somewhere else. An
 * uncropped group re-boxes byte-identically; the same group with insets does not.
 * Refusing is honest — the insets could in principle be rewritten into the new
 * frame, but a crop the author placed against the OLD box has no single obviously
 * right reading in a new one, and picking one would be an edit wearing a
 * reparametrization's name.
 *
 * EFFECTS DO NOT REFUSE, also measured: shadow/bloom/blend are cast by the MEMBER
 * SILHOUETTE (the composited subtree), not by the group's box, so they survive a
 * re-box untouched.
 *
 * Args:
 *   state (object): the folded, equation-evaluated group state
 *   newBox (object): {x, y, w, h} — the box the command is about to write, in the
 *     same terms the command writes it (x/y are the group's own stored world x/y)
 *
 * Returns:
 *   {object|null}: the state patch to write alongside the box, or null to refuse
 *
 * @example // a plain group re-binds at the new pose — identity influence preserved
 * @example groupReparametrizeToBox({x: 40, y: 20, rotation: 0, scale: 1}, {x: 100, y: 80, w: 240, h: 180}) // {bind: {x: 100, y: 80, rotation: 0, scale: 1}}
 * @example // a rotated/scaled group carries its own rotation+scale into the new bind
 * @example groupReparametrizeToBox({x: 0, y: 0, rotation: 30, scale: 2}, {x: 5, y: 5, w: 10, h: 10}) // {bind: {x: 5, y: 5, rotation: 30, scale: 2}}
 * @example groupReparametrizeToBox({w: 200, h: 100, cropRight: 40}, {x: 0, y: 0, w: 150, h: 100}) // null (a crop is defined in the box being replaced)
 */
export function groupReparametrizeToBox(state, newBox) {
  if (groupCropRect(state) !== null) return null; // the clip lives in the old box
  return {
    bind: {
      x: newBox.x, y: newBox.y,
      rotation: state.rotation ?? 0,
      scale: state.scale ?? 1,
    },
  };
}

// GROUP ASSEMBLY TREATMENTS — the effects bundle wraps a group's WHOLE MEMBER
// SUBTREE as one composite (see SUBTREE EFFECTS above, and groupFoldsSubtree), so
// these model how a COLLECTION of separate objects is made to read as ONE physical
// thing. The identical numbers on a rect would be an ordinary drop shadow; here the
// shadow is cast by a silhouette made of many objects, which is a different picture
// and the only reason a family over universal keys belongs on this widget at all.
//
// Ordered by how much of the subtree the treatment consumes: outside the silhouette
// (1-2), eating into it (3-4), emitting from it (5-6), rewriting every pixel (7-8),
// then removing the edge entirely (9).
//
// FULL — all five knobs in every row including the identities, because application
// is an overlay (plugins/demo/sky.js:63-66): without them, hovering "Ink Stamp"
// after "Neon Glass" would leave the bloom on.
//
// EVERY ROW MUST MAKE groupFoldsSubtree TRUE or it renders NOTHING. An effect-free,
// uncropped group is a pure ghost, so a preset that left every knob at its identity
// would not be a dull row, it would be a BLANK one. That is a one-line bare-node
// check and the family's own suite makes it.
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };

const GROUP_TREATMENTS = [
  { name: "Cut Paper", description: "A paper cut-out lying flat on the page — one tight, close shadow under the whole assembly's outline rather than under each piece of it.",
    props: { shadow: { dx: 0, dy: 3, blur: 6, color: "#000000", opacity: 0.35 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Lifted Card", description: "The same assembly held well above the page: a long, soft, low-contrast shadow that says height rather than contact.",
    props: { shadow: { dx: 0, dy: 18, blur: 36, color: "#000000", opacity: 0.32 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Pressed Into The Page", description: "A debossed impression — a tight inner shadow all round the composite silhouette, so the assembly reads as stamped INTO the surface instead of resting on it.",
    props: { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 0, blur: 8, color: "#000000", opacity: 0.55 }, softEdges: 0 } },
  { name: "Vignette Well", description: "A deep recess: the same inner shadow taken to a very wide blur, darkening far into the assembly so the whole group sits at the bottom of a well.",
    props: { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 0, blur: 64, color: "#000000", opacity: 0.45 }, softEdges: 0 } },
  { name: "Backlit Sign", description: "A lit sign face — a broad bloom leaving the composite silhouette, so the assembly glows outward as ONE shape rather than as a crowd of glowing parts.",
    props: { shadow: SHADOW_OFF, bloom: { radius: 26, strength: 0.6 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Neon Glass", description: "Glow plus additive compositing: a wide strong bloom over a screen blend, so the assembly stops reflecting the backdrop and starts emitting into it.",
    props: { shadow: SHADOW_OFF, bloom: { radius: 34, strength: 0.85 }, blendMode: "screen", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Ink Stamp", description: "Ink soaking into the backdrop — a multiply blend over the whole composite, so the assembly can only darken what is behind it and never lighten it.",
    props: { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "multiply", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Light Leak", description: "Film fogged by stray light: a faint bloom under a screen blend, washing the assembly pale into the backdrop instead of sitting on top of it.",
    props: { shadow: SHADOW_OFF, bloom: { radius: 12, strength: 0.25 }, blendMode: "screen", innerShadow: INNER_OFF, softEdges: 0 } },
  { name: "Fog Edge", description: "The assembly dissolving at its own boundary — a wide soft-edge falloff on the composite, so the group has no border anywhere, only a fade.",
    props: { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 34 } },
];

// GROUP MATTES — the cropInsets bundle trims the group's own bbox and CLIPS the
// whole member composite (groupCropRect above). Key-disjoint from GROUP_TREATMENTS,
// and unlike most claimed orthogonality the RENDERER proves this pair composes:
// emit() nests the cropSubtree INSIDE applyEffects, so a matte plus a treatment
// stacks in one draw rather than fighting.
//
// A LAYOUT FAMILY, which is SPEC.md §5's own stated condition for touching extents:
// the four insets are stored in ABSOLUTE canvas units, so a literal would be right
// at exactly one group size and wrong at every other. They are written as EQUATIONS
// on the group's own extents, `=`-marked per R6-25.1 — the relation IS the preset's
// content, which is the case §5b calls correct and precedented.
//
// Math.abs IS NOT DECORATION: a stored w/h MAY BE NEGATIVE (that is how Flip is
// stored) and core/expressions.js reads the RAW extent for a plain `self.` prop, so
// a bare `self.h * 0.12` on a flipped group yields a negative inset that
// groupCropRect clamps to zero — a matte that silently does nothing. The absolute
// value is the loud-by-construction form.
//
// Ordered by weight, lightest to heaviest. Every row leaves at least one inset
// non-zero, so groupFoldsSubtree is true and the crop actually renders.
const GROUP_MATTES = [
  { name: "Hairline Trim", description: "The printer's bleed trim — a two-percent bite off every edge, just enough to cut a clean boundary through whatever overhangs it.",
    props: { cropTop: "= Math.abs(self.h) * 0.02", cropLeft: "= Math.abs(self.w) * 0.02", cropRight: "= Math.abs(self.w) * 0.02", cropBottom: "= Math.abs(self.h) * 0.02" } },
  { name: "Letterbox", description: "The projection matte: bars across the top and bottom with the full width kept, the shape a wide film takes on a squarer frame.",
    props: { cropTop: "= Math.abs(self.h) * 0.12", cropLeft: 0, cropRight: 0, cropBottom: "= Math.abs(self.h) * 0.12" } },
  { name: "Pillarbox", description: "The opposite matte — bars down each side with the full height kept, the shape a tall image takes in a wide frame.",
    props: { cropTop: 0, cropLeft: "= Math.abs(self.w) * 0.12", cropRight: "= Math.abs(self.w) * 0.12", cropBottom: 0 } },
  { name: "Caption Plate", description: "A lantern-slide plate: thin even margins on three sides and a deep foot left clear at the bottom for a caption to sit in.",
    props: { cropTop: "= Math.abs(self.h) * 0.04", cropLeft: "= Math.abs(self.w) * 0.04", cropRight: "= Math.abs(self.w) * 0.04", cropBottom: "= Math.abs(self.h) * 0.22" } },
  { name: "Gallery Mat", description: "The framer's mat, cut with a heavier bottom margin than top — the asymmetry that makes a hung picture read as optically centred rather than geometrically so.",
    props: { cropTop: "= Math.abs(self.h) * 0.1", cropLeft: "= Math.abs(self.w) * 0.1", cropRight: "= Math.abs(self.w) * 0.1", cropBottom: "= Math.abs(self.h) * 0.14" } },
];

export const groupPlugin = {
  type: "group",
  ephemeral: EPHEMERAL.NONE,
  title: "Group",
  presetFamilies: [
    { id: "treatment", title: "Assembly treatments", presets: GROUP_TREATMENTS },
    { id: "matte", title: "Matte and trim", presets: GROUP_MATTES },
  ],
  // ghost:true — no rendered volume (emit() → []); its outline is editor-only
  // chrome shown under Show Ghosts (core/derive.isGhostNode via this capability).
  // transform + bbox + resizable so a selected group moves/resizes/rotates like
  // any bbox widget; the derivation stage propagates that to members.
  //
  // armature:true — THIS WIDGET PARENTS OTHER ITEMS THROUGH ITS SIMILARITY, so
  // every scale-shaped gesture must drive its `scale` and never its w/h (user,
  // 2026-08-01: "When the group is scaled everything inside should scale with
  // it"). It is a capability rather than a `type === "group"` test because
  // core/registry.js states the rule in as many words — "tools/UI dispatch on
  // these — NEVER on type" — and because the fact now has FOUR readers: the
  // handle resize, the S modal, the multi-resize, and the drag-kind announcement.
  // The word is the manifest's own for this mechanism ("THE ARMATURE MECHANISM",
  // groups rough draft), not a new coinage.
  //
  // WHY IT CANNOT BE DERIVED FROM `members`. A widget could hold item ids without
  // parenting them (a crop box targets an item; an arrow binds to two). What makes
  // a group an armature is that core/derive.applyGroupParenting composes its
  // {x, y, rotation, scale} onto those items' worlds — a fact about the
  // DERIVATION, invisible in the state. The capability is where that gets said.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, ghost: true, armature: true },
  defaults: {
    type: "group", x: 0, y: 0, w: 0, h: 0, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A default-constructed group controls nothing and sits at its own bind
    // pose (identity influence). groupSelection overwrites members + bind +
    // geometry at creation; these defaults only make a bare group inert/legal.
    members: [], bind: { x: 0, y: 0, rotation: 0, scale: 1 },
    // SUBTREE EFFECTS + CROP: the group composes the shared EFFECTS bundle and
    // the cropInsets bundle so its whole member subtree can be shadowed/bloomed/
    // blended/inner-shadowed/cropped as one unit. Defaults are effect-OFF (shadow
    // opacity 0, bloom strength 0, blend normal, inner opacity 0) and crop-0, so a
    // group with untouched knobs is a pure ghost — byte-identical to before.
    ...bundleNestedDefaults("effects"),
    ...bundleDefaults("cropInsets"), // cropTop/cropLeft/cropRight/cropBottom: 0
  },
  // ID-VALUED STATE PATHS (core/document.js clonedItemStates): `members` holds
  // raw itemIds, NOT an equation, so the token rewriter that reroutes `@id`
  // references when a selection is cloned cannot see it. Declared here for the
  // same reason `legacyKeys` is — a declarative, no-type-special-casing seam, so
  // core never hard-codes "group" (paths, exactly like WORLD_AFFECTING_LEAVES).
  itemRefs: [["members"]],
  inspector: [
    // The eight shared bbox rows, COMPOSED from the registry rather than
    // re-typed. They used to be hand-copied literals here — byte-identical to
    // BUNDLES.positioning except for the `help` text they silently lacked, and
    // exactly the copy-paste drift core/properties.js exists to end: the `angle`
    // KIND that put the rotary dial on `rotation` reached every other bbox widget
    // through the bundle and would have skipped this one.
    ...bundle("positioning"),
    // The subtree crop (cropInsets) + the effects bundle — the SAME rows every
    // box/drawn widget composes, applied here to the group's member composite.
    ...bundle("cropInsets"),
    ...bundle("effects"),
    // Ungroup is a Property Panel ACTION (manifest UNGROUP spec), surfaced by
    // the Inspector's action seam, not a per-property row — declared here so the
    // panel can offer it when a group is selected (the app owns the handler).
    { key: "__ungroup", label: "Ungroup", kind: "action", command: "ungroup", category: "group" },
  ],
  /**
   * Pure function. A group renders NOTHING of its own (it is a ghost) UNLESS it
   * folds its members into a composited SUBTREE — see groupFoldsSubtree. When it
   * does, `membersIR` (sceneIR's arg-2 seam — the cropbox targetWorldIR
   * precedent) is the group's members' ABSOLUTE-world IR, and this nests it in
   * ONE cropSubtree (crop insets) and/or ONE effectSubtree (via applyEffects —
   * shadow/bloom/blend/inner-shadow), so the effect/crop wraps the whole member
   * silhouette as a unit. Absent/empty `membersIR` (a non-folding group, or one
   * with no present members) ⇒ [] (the pure-ghost path, byte-identical).
   *
   * `world` is the group's ABSOLUTE world (arg 3). A crop op's region is
   * group-LOCAL, so when an effect ALSO wraps it the crop op must ride
   * pushTransform(world) inside the effectSubtree's SEPARATELY-flattened content;
   * the members are already absolute so they take an identity wrap (no
   * double-transform). sceneIR's outer pushTransform(world) then scales the
   * effect sigmas/offset by the group's world.
   *
   * @param {object} s - evaluated group state
   * @param {object[]|null} membersIR - the members' absolute-world IR (sceneIR)
   * @param {object} world - the group's absolute world transform
   * @returns {object[]}
   *
   * @example groupPlugin.emit({}) // [] (non-folding ghost — no members handed in)
   * @example groupPlugin.emit({blendMode: "multiply"}, [], {x: 0, y: 0, rotation: 0, scale: 1}) // [] (no present members → ghost)
   * @example groupPlugin.emit({blendMode: "multiply"}, [{op: "rect"}], {x: 0, y: 0, rotation: 0, scale: 1})[0].op // "effectSubtree"
   */
  emit(s, membersIR, world) {
    if (!Array.isArray(membersIR) || membersIR.length === 0) return [];
    const crop = groupCropRect(s);
    const content = crop
      ? [cropSubtree({ x: crop.x, y: crop.y, w: crop.w, h: crop.h, content: membersIR })]
      : membersIR;
    // applyEffects wraps `content` in pushTransform(effectWorld) inside the
    // effectSubtree (separately flattened from identity): the crop op's region is
    // group-LOCAL → it needs the group world; the members are already ABSOLUTE →
    // identity. Effects OFF ⇒ applyEffects returns `content` unchanged (crop-only).
    return applyEffects(content, s, crop ? world : T.identity(), { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Does this group fold its member subtree into one composited unit? derive.js
  // (resolveGroupSubtrees) calls this to decide whether to fold + suppress the
  // members from the top-level render walk (the manifest cropbox fence: derive
  // does suppression/ordering, the plugin owns the render shape).
  foldsSubtree: groupFoldsSubtree,
  // THE REPARAMETRIZATION PROTOCOL (core/registry.js): what "Set Size to Ink
  // Bounds" costs this widget's interior. A group's is a BIND REWRITE — it draws
  // nothing itself, so the only thing its box means is the reference its member
  // influence is measured from, and re-binding at the new pose keeps that
  // influence the identity. Refuses when CROPPED (the clip is defined in the box
  // being replaced). See groupReparametrizeToBox for the tween-linearity argument.
  reparametrizeToBox: groupReparametrizeToBox,
  // Effects halo (shadow/bloom spill) extends the group's cull AABB (core/view.js
  // hook), so an effected group isn't culled before its halo would show. Zero when
  // effect-off — the default culling of a plain ghost group is untouched.
  cullMargin: effectsCullMargin,
  // Border-only hit (the camera precedent): clicking the group's OUTLINE band
  // selects the group; clicking its interior falls through to the member under
  // the cursor (pickNode is topmost-first). `tol` is the editor's world-unit
  // grab tolerance (constant screen-space feel at any zoom).
  hitTest(s, lx, ly, tol = 6) {
    return borderBandHit(s, lx, ly, tol);
  },
  anchors: standardBBoxAnchors,
  // NOTE: no `commands` here — "Group Selection" / "Ungroup" are registered as
  // GLOBAL commands in web/App.svelte (they operate on the selection + need the
  // app's AABB/keyframe-baking helpers, not a single widget's state).
};
