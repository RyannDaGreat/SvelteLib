/**
 * EMPTY — a blender-style empty, and the widget that REPLACES `anchor_point`
 * (user, 2026-08-13: "Empties. Replace the anchor widget. I want empties. Full
 * transform, blender-style.", grouped as "AM - which replaces anchor widget and
 * looks like blender empty").
 *
 * WHAT AN EMPTY IS, and why it is not just the anchor point renamed. Blender's
 * empty is a transform with no geometry: it has a full position/rotation/scale,
 * it draws an axis cross in the viewport ONLY, it renders nothing, and other
 * things reference it. `anchor_point` was two thirds of that and stopped: it
 * exposed x/y/z rows ALONE — no rotation and no scale row — so a rig could point
 * at it but could not be driven BY it. The whole reason to reach for an empty is
 * to have one transform many things follow, and a point with no orientation
 * cannot be that.
 *
 * FULL TRANSFORM is therefore the feature, not a detail: x, y, z, rotation and
 * scale are all inspector rows and all keyframable like any widget's, so
 * `= my_empty.rotation` and `= my_empty.scale` are readable from an equation the
 * same way `my_empty.pt.x` always was.
 *
 * SIZE IS DISPLAY SIZE, NOT A BOUNDING BOX (blender's `empty_display_size`). An
 * empty has no extent to resize — it occupies no space and paints nothing — so
 * `resizable: false` stands, exactly as it did on `anchor_point`, and the stored
 * w/h are the CROSS's drawn arm span and its grab target. That is also why the
 * axis anchors below are worth having: they are the visible tips of the cross,
 * so an equation can name a point the author can SEE, and moving the display
 * size moves them, which is the one thing the display size is for.
 *
 * GHOST, AND EDITOR-ONLY. `capabilities.ghost` + `emit() → []`: it has no
 * rendered volume, so it never reaches sceneIR, never presents and never
 * exports. Its axis cross is drawn by web/CanvasView.svelte's overlay — the same
 * fence every other piece of chrome sits behind (the ghost outline, the anchor
 * X, the crop box's frame). A blender empty behaves identically: visible in the
 * viewport, absent from the render.
 *
 * ANCHOR IDS ARE A COMPATIBILITY CONTRACT. `pt` is kept as the CENTRE anchor's
 * id, unchanged from `anchor_point`, because every equation an existing deck
 * wrote is `@<itemId>_pt.x` / `<slug>.pt.x` — the item id and the anchor id are
 * the whole reference, so keeping both means the migration in core/document.js
 * rewrites the TYPE and nothing else has to move. The four axis tips (`+x`, `-x`,
 * `+y`, `-y`) are additions; no legacy document can name them.
 *
 * NEGATIVE EXTENTS: a stored w/h may be negative (a flip). `anchors()` reads the
 * raw state, and every reader of a plugin's anchors resolves the sign first
 * (core/geometry.normalizedBox for derived nodes, core/expressions.unsignedState
 * before derivation) — so the halves below are computed from the values this
 * plugin is handed, and the cross of a flipped empty is its own mirror image,
 * which for a symmetric cross is the same picture. `localBounds` returns the
 * cross's INK, which is the box itself.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";

/**
 * The default display size of a new empty, in world units — the arm span of the
 * drawn cross and its grab target, NOT a bounding box (see the header).
 *
 * INHERITED FROM `anchor_point`, deliberately and by value: that widget shipped
 * 20 as its grab box, every document that carries one stores 20, and the
 * migration rewrites the type WITHOUT touching w/h — so a migrated empty must
 * draw at the size its document already says. Choosing a different default here
 * would make a fresh empty and a migrated one visibly different for no reason.
 * It was flagged PENDING USER RATIFICATION there and still is here.
 */
const EMPTY_DISPLAY_W = 20;
const EMPTY_DISPLAY_H = 20;

export const emptyPlugin = {
  type: "empty",
  ephemeral: EPHEMERAL.NONE,
  title: "Empty",
  // ghost:true → no rendered volume (isGhostNode), so the editor draws its
  // phantom outline and its axis cross for selection. transform → body-drag
  // moves x/y. NOT resizable: the size is a DISPLAY size, edited by its row.
  capabilities: { bbox: true, transform: true, resizable: false, backdrop: false, ghost: true },
  defaults: {
    type: "empty", x: 300, y: 300, w: EMPTY_DISPLAY_W, h: EMPTY_DISPLAY_H, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about its own center — the same default every transform
    // widget carries. It MATTERS here in a way it did not for a bare point: an
    // empty's rotation is a value other items read, so the pivot decides what
    // "the empty's orientation" means, and the centre is the cross's own origin.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    opacity: 1,
  },
  // THE FULL TRANSFORM (the feature — see the header). `anchor_point` published
  // x/y/z alone; rotation and scale are what make this an empty rather than a
  // point, and both are ordinary keyframable rows.
  inspector: [
    { key: "x", label: "X", kind: "number", category: "transform" },
    { key: "y", label: "Y", kind: "number", category: "transform" },
    { key: "z", label: "Z order", kind: "number", category: "transform" },
    { key: "rotation", label: "Rotation", kind: "number", category: "transform" },
    { key: "scale", label: "Scale", kind: "number", category: "transform" },
    { key: "w", label: "Display size", kind: "number", category: "transform", help: "The drawn arm span of the axis cross, in world units. An empty has no extent — this is blender's empty_display_size, not a bounding box." },
  ],
  /** Pure function. Paints NOTHING — an empty is a transform with no geometry. */
  emit() {
    return [];
  },
  /**
   * Pure function. The LOCAL rect the empty's INK occupies — its cross fills the
   * display box exactly, so the ink IS the box. Declared rather than omitted
   * because culling, band select and the copy/export capture rect all read it
   * (registry BOUNDS protocol), and a widget with no localBounds is treated as
   * having no extent, which would make an empty unbandselectable.
   *
   * @example emptyPlugin.localBounds({w: 20, h: 20}) // {x: 0, y: 0, w: 20, h: 20}
   */
  localBounds(state) {
    return { x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 };
  },
  /**
   * Pure function. The referencable points: `pt` at the CENTRE (the id every
   * legacy `anchor_point` equation names — kept unchanged so the migration needs
   * to rewrite nothing but the type), the four AXIS TIPS of the drawn cross, and
   * the standard bbox anchors so the empty composes with arrow drops and snapping
   * like any other widget.
   *
   * The tips are named for the direction they point in LOCAL space; the world
   * position each resolves to follows the empty's rotation and scale through the
   * usual worldTransform, so `@e_+x.x` tracks a rotating empty's arm.
   *
   * @example emptyPlugin.anchors({w: 20, h: 20}).slice(0, 5).map((a) => a.id) // ["pt", "+x", "-x", "+y", "-y"]
   * @example emptyPlugin.anchors({w: 20, h: 20})[0] // {id: "pt", x: 10, y: 10}
   * @example emptyPlugin.anchors({w: 20, h: 20})[1] // {id: "+x", x: 20, y: 10}
   */
  anchors(state) {
    const w = state.w ?? 0, h = state.h ?? 0;
    const cx = w / 2, cy = h / 2;
    return [
      { id: "pt", x: cx, y: cy },
      { id: "+x", x: w, y: cy },
      { id: "-x", x: 0, y: cy },
      { id: "+y", x: cx, y: h },
      { id: "-y", x: cx, y: 0 },
      ...standardBBoxAnchors(state),
    ];
  },
  commands: [
    { id: "add-empty", title: "Add Empty", icon: "mdi:vector-point", run: (app) => app.addItem(emptyPlugin.defaults) },
  ],
};
