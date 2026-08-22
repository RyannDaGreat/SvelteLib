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
 * SIZE IS DISPLAY SIZE, NOT A BOUNDING BOX (blender's `empty_display_size`), AND
 * IT IS ONE NUMBER. An empty has no extent to resize — it occupies no space and
 * paints nothing — so `resizable: false` stands, exactly as it did on
 * `anchor_point`, and the stored `w` is the CROSS's drawn arm span and its grab
 * target. `w` alone: blender's display size is a single scalar, the Display size
 * row is the only editor either extent has, and it writes `w`. So the cross is
 * SQUARE BY CONSTRUCTION — `anchors()` and `localBounds()` take the half-arm from
 * `w` on BOTH axes and read `h` only to find the centre the cross hangs on.
 *
 * DERIVING THE VERTICAL ARM FROM `h` WAS A DEFECT, not a second display size:
 * nothing anywhere edits an empty's `h` (there is no row, and `resizable: false`
 * means no handle), so it sat at its default forever while `w` moved. Setting
 * Display size to 60 drew a 30-unit horizontal half-arm against a 10-unit
 * vertical one — an asymmetric "axis cross" — and put the +y tip somewhere the
 * author had not asked for. The centre still comes from the box (`h/2`) so the
 * cross stays on the item's own rotation pivot, which defaults to the box centre.
 *
 * GHOST, AND EDITOR-ONLY. `capabilities.ghost` + `emit() → []`: it has no
 * rendered volume, so it never reaches sceneIR, never presents and never
 * exports. Its axis cross is drawn by web/CanvasView.svelte's overlay — the same
 * fence every other piece of chrome sits behind (the ghost outline, the anchor
 * X, the crop box's frame). A blender empty behaves identically: visible in the
 * viewport, absent from the render.
 *
 * ANCHOR IDS ARE A COMPATIBILITY CONTRACT, AND THEY MUST BE SPELLABLE. `pt` is
 * kept as the CENTRE anchor's id, unchanged from `anchor_point`, because every
 * equation an existing deck wrote is `@<itemId>_pt.x` / `<slug>.pt.x` — the item
 * id and the anchor id are the whole reference, so keeping both means the
 * migration in core/document.js rewrites the TYPE and nothing else has to move.
 *
 * The four axis tips are additions, and they are named `plusx` / `minusx` /
 * `plusy` / `minusy` — the sigils `+x`/`-x`/`+y`/`-y` written out as words. They
 * shipped as the sigils, and THE GRAMMAR CANNOT SPELL THOSE: an equation
 * reference is `[A-Za-z0-9_]` only (core/expressions.js REF_RE), so `box_+x.x`
 * did not tokenize as a reference at all — the display grammar threw
 * `Unknown variable "box_"` and a stored `@e_+x.x` silently failed to resolve,
 * falling back to the reading widget's default. That is not a theoretical bound:
 * CanvasView's anchor-bind offers EVERY id `anchors()` publishes, so dropping an
 * arrow end on a visible cross tip WROTE one of those unevaluable equations.
 * NO MIGRATION IS NEEDED, and that is a consequence of the same fact: a stored
 * document could only contain the old spelling if an author had bound to it, and
 * the grammar made writing such a binding by hand impossible while every binding
 * the app wrote was already broken on arrival. Nothing correct exists to migrate.
 * NO UNDERSCORE IN A TIP ID, either — the display grammar splits a head at the
 * LAST "_" so it can find snake_case slugs, which makes an underscored anchor id
 * writable but unreadable (the KNOWN BOUND pinned in tests/stored_ref_split_test.js).
 * That same suite is the census: it sweeps every registered plugin's anchor ids
 * through the display grammar, so this cannot drift back.
 *
 * NEGATIVE EXTENTS: a stored w/h may be negative (a flip). `anchors()` reads the
 * raw state, and every reader of a plugin's anchors resolves the sign first
 * (core/geometry.normalizedBox for derived nodes, core/expressions.unsignedState
 * before derivation) — so the arms below are computed from the values this plugin
 * is handed, sign and all, and the cross of a flipped empty is its own mirror
 * image, which for a symmetric cross is the same picture. `localBounds` returns
 * the cross's INK, which is the square the arms sweep; a negative `w` makes that
 * square state itself from the opposite corner, describing the same region.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";

/**
 * The default display size of a new empty, in world units — the arm span of the
 * drawn cross and its grab target, NOT a bounding box (see the header). ONE
 * number: `defaults.h` starts equal to it so a fresh empty's property box and
 * its cross coincide exactly, but only `w` is ever edited.
 *
 * INHERITED FROM `anchor_point`, deliberately and by value: that widget shipped
 * 20 as its grab box, every document that carries one stores 20, and the
 * migration rewrites the type WITHOUT touching w/h — so a migrated empty must
 * draw at the size its document already says. Choosing a different default here
 * would make a fresh empty and a migrated one visibly different for no reason.
 * It was flagged PENDING USER RATIFICATION there and still is here.
 */
const EMPTY_DISPLAY_SIZE = 20;

export const emptyPlugin = {
  type: "empty",
  ephemeral: EPHEMERAL.NONE,
  title: "Empty",
  // ghost:true → no rendered volume (isGhostNode), so the editor draws its
  // phantom outline and its axis cross for selection. transform → body-drag
  // moves x/y. NOT resizable: the size is a DISPLAY size, edited by its row.
  capabilities: { bbox: true, transform: true, resizable: false, backdrop: false, ghost: true },
  defaults: {
    type: "empty", x: 300, y: 300, w: EMPTY_DISPLAY_SIZE, h: EMPTY_DISPLAY_SIZE, z: 0, rotation: 0, scale: 1,
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
    { key: "w", label: "Display size", kind: "number", category: "transform", help: "The drawn arm span of the axis cross, in world units — ONE number, used on both axes. An empty has no extent: this is blender's empty_display_size, not a bounding box." },
  ],
  /** Pure function. Paints NOTHING — an empty is a transform with no geometry. */
  emit() {
    return [];
  },
  /**
   * Pure function. The LOCAL rect the empty's INK occupies — the square its two
   * arms sweep, centred on the box centre. Declared rather than omitted because
   * culling, band select and the copy/export capture rect all read it (registry
   * BOUNDS protocol), and a widget with no localBounds is treated as having no
   * extent, which would make an empty unbandselectable.
   *
   * It is NOT the property box: the arm span is `w` on both axes (see the
   * header), so the ink reaches outside a box whose `h` differs. Hit testing
   * takes the UNION of the two (core/derive.clickableLocalRect), so the whole
   * cross is grabbable either way.
   *
   * @example emptyPlugin.localBounds({w: 20, h: 20}) // {x: 0, y: 0, w: 20, h: 20}
   * @example emptyPlugin.localBounds({w: 60, h: 20}) // {x: 0, y: -20, w: 60, h: 60} (square ink, centred on the box centre)
   */
  localBounds(state) {
    const w = state.w ?? 0, h = state.h ?? 0;
    const arm = w / 2; // half the display size — the same half-arm on both axes
    return { x: w / 2 - arm, y: h / 2 - arm, w: 2 * arm, h: 2 * arm };
  },
  /**
   * Pure function. The referencable points: `pt` at the CENTRE (the id every
   * legacy `anchor_point` equation names — kept unchanged so the migration needs
   * to rewrite nothing but the type), the four AXIS TIPS of the drawn cross, and
   * the standard bbox anchors so the empty composes with arrow drops and snapping
   * like any other widget.
   *
   * The tips are named for the direction they point in LOCAL space, spelled in
   * words because the equation grammar has no `+`/`-` (see the header); the world
   * position each resolves to follows the empty's rotation and scale through the
   * usual worldTransform, so `@e_plusx.x` tracks a rotating empty's arm.
   *
   * @example emptyPlugin.anchors({w: 20, h: 20}).slice(0, 5).map((a) => a.id) // ["pt", "plusx", "minusx", "plusy", "minusy"]
   * @example emptyPlugin.anchors({w: 20, h: 20})[0] // {id: "pt", x: 10, y: 10}
   * @example emptyPlugin.anchors({w: 20, h: 20})[1] // {id: "plusx", x: 20, y: 10}
   * @example // the arm span is `w` on BOTH axes, so a wide box still crosses squarely:
   * @example emptyPlugin.anchors({w: 60, h: 20})[3] // {id: "plusy", x: 30, y: 40}
   */
  anchors(state) {
    const w = state.w ?? 0, h = state.h ?? 0;
    const cx = w / 2, cy = h / 2;
    const arm = w / 2; // ONE display size, both axes — `h` only places the centre
    return [
      { id: "pt", x: cx, y: cy },
      { id: "plusx", x: cx + arm, y: cy },
      { id: "minusx", x: cx - arm, y: cy },
      { id: "plusy", x: cx, y: cy + arm },
      { id: "minusy", x: cx, y: cy - arm },
      ...standardBBoxAnchors(state),
    ];
  },
  commands: [
    { id: "add-empty", title: "Add Empty", icon: "mdi:vector-point", run: (app) => app.addItem(emptyPlugin.defaults) },
  ],
};
