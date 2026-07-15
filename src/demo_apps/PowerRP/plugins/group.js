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
 * This file owns ONLY the group's own widget definition. Grouping/ungrouping
 * commands (which need the selection + collective AABB + keyframe baking) live
 * in web/app.svelte.js (groupSelection / ungroupSelection) — the crop-box
 * precedent where cross-item orchestration lives in the app, not the plugin.
 */

import { standardBBoxAnchors } from "../core/derive.js";

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
    // Ungroup is a Property Panel ACTION (manifest UNGROUP spec), surfaced by
    // the Inspector's action seam, not a per-property row — declared here so the
    // panel can offer it when a group is selected (the app owns the handler).
    { key: "__ungroup", label: "Ungroup", kind: "action", command: "ungroup", category: "group" },
  ],
  /** Pure function. A group renders NOTHING (it is a ghost — its bbox is
   * editor-only chrome). Empty IR means sceneIR emits no ops for it, so it is
   * absent from every export/present/thumbnail/CLI render, exactly like the
   * camera. @example groupPlugin.emit({}) // [] */
  emit() {
    return [];
  },
  // Border-only hit (the camera precedent): clicking the group's OUTLINE band
  // selects the group; clicking its interior falls through to the member under
  // the cursor (pickNode is topmost-first). `tol` is the editor's world-unit
  // grab tolerance (constant screen-space feel at any zoom).
  hitTest(s, lx, ly, tol = 6) {
    const m = tol;
    const inOuter = lx >= -m && lx <= (s.w ?? 0) + m && ly >= -m && ly <= (s.h ?? 0) + m;
    const inInner = lx >= m && lx <= (s.w ?? 0) - m && ly >= m && ly <= (s.h ?? 0) - m;
    return inOuter && !inInner;
  },
  anchors: standardBBoxAnchors,
  // NOTE: no `commands` here — "Group Selection" / "Ungroup" are registered as
  // GLOBAL commands in web/App.svelte (they operate on the selection + need the
  // app's AABB/keyframe-baking helpers, not a single widget's state).
};
