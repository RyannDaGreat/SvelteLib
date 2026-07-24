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

export const groupPlugin = {
  type: "group",
  title: "Group",
  // ghost:true — no rendered volume (emit() → []); its outline is editor-only
  // chrome shown under Show Ghosts (core/derive.isGhostNode via this capability).
  // transform + bbox + resizable so a selected group moves/resizes/rotates like
  // any bbox widget; the derivation stage propagates that to members.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, ghost: true },
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
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" },
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" },
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
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
