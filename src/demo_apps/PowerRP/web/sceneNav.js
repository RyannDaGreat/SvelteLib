/**
 * SCENE NAVIGATION — "double-click it, it goes into mouse-look" (R6-1.2). The
 * activate handler that lets a 3D viewport's CAMERA be flown with the pointer.
 *
 * A widget declares `activate: "navigate_scene"` plus a `sceneCamera` descriptor
 * and gets orbit / truck / dolly / zoom for free. Nothing here knows what is
 * inside the viewport: the handler only ever asks the plugin two pure questions,
 * which is the shape web/interiorNav.js established and plugins/demo/globe_map.js
 * proved general.
 *
 * ── THE PLUGIN CONTRACT (DOM-free, pure, lives in the plugin) ─────────────────
 *   sceneCamera: {
 *     // Pure. Folded state → the camera pose the widget currently shows.
 *     pose(state) → {targetX, targetY, targetZ, yaw, pitch, roll, distance, fov}
 *     // Pure. Folded state + a NEW pose → the item-state writes that store it,
 *     // as a flat {stateKey: value} map. Every key must be a KEYFRAMABLE LEAF;
 *     // the handler writes them through app.setPreview / commitPreview exactly
 *     // like an Inspector row edit.
 *     writes(state, pose) → {stateKey: value}
 *   }
 *
 * ── WHY A SECOND HANDLER RATHER THAN GENERALIZING interiorNav ────────────────
 * `interiorView.window(state)` returns a 2D RECT. A 3D pose is eight coupled
 * scalars and is not a rect, and two shipped widgets (the Mandelbrot and the map)
 * depend on the rect contract. web/widget_handlers.js:18 states the intended move
 * for exactly this case: "Adding a new kind of double-click behaviour … is a new
 * descriptor here (usually in its own file, imported below) plus one string in
 * the plugin. It does NOT touch CanvasView, App.svelte, or any other widget." So
 * this file is precedent's own instruction, not a departure from it.
 *
 * ── THE MID-GESTURE CAMERA LIVES NOWHERE, AND THAT IS THE DESIGN ─────────────
 * RenderTree = pure(document, [[slide, alpha]]). A transient camera held in the
 * editor would make the render a function of UI state: the CLI renderer and the
 * video export would disagree with the screen, and a reload would lose the shot.
 * So every tick reads the pose from the node's CURRENT (preview-inclusive) state,
 * computes the next one with a pure function below, and stages the WHOLE write
 * set through `app.setPreview` — document unchanged, no undo entry. The host
 * commits on pointer-up, or after ZOOM_GESTURE_IDLE_MS of wheel quiet, so one
 * gesture is ONE undo unit and lands as a keyframe on the current slide.
 *
 * Writing the WHOLE set every tick is not redundancy: `setPreview` REPLACES
 * previewDelta wholesale, so a narrower call silently drops keys a previous frame
 * staged — the reason web/interiorNav.previewInteriorWindow documents the same
 * rule.
 *
 * ── THIS MODE OWNS THE POINTER, AND interiorNav DELIBERATELY DOES NOT ────────
 * `interiorNav` declares no `onPan` on purpose, after a direct user correction
 * ("so that way I can still drag the element around while I'm editing it"): its
 * interior is driven from the wheel alone and a plain drag still MOVES the
 * widget. THIS MODE DIVERGES, and the manifest is the authority for it — R6-1.2
 * says "Double-click the widget and you are inside the scene, FLYING WITH THE
 * MOUSE". Mouse-look is a pointer drag; there is no wheel-only spelling of it. So
 * while this mode is live a drag LOOKS instead of moving the widget, and Escape
 * gives the widget back. If you are here to "fix" the inconsistency with
 * interiorNav: don't — it is deliberate, it is asymmetric on purpose, and both
 * sides of the asymmetry are user rulings.
 *
 * ── ESCAPE IS REGISTERED, AND REGISTERED FOR FREE ───────────────────────────
 * Declaring `mode` IS the registration. web/widget_handlers.canvasModes() walks
 * both phases and core/shortcut_entries.handShortcutEntries generates the mode's
 * hints, its narration AND its scoped Escape entry from the declaration. Do not
 * hand-roll a keydown listener: an unregistered Escape is stolen by the three
 * that already exist, and a shortcut that is not in the registry does not exist.
 *
 * DOM-free at import: pure math plus one descriptor object.
 */

import { equationBoundKeys } from "./canvas/equationBinding.js";
import { expZoomFactor } from "../../../lib/panZoomMath.js";
import { ZOOM_GESTURE_IDLE_MS } from "./interiorNav.js";

/**
 * How much of a full turn a drag across the widget's whole width sweeps. One box
 * width = half a turn is the near-universal orbit-control feel (Blender, every
 * glTF viewer, every product configurator): a comfortable drag gets you to the
 * other side of the subject without letting go, and a small nudge is still small.
 */
const TURNS_PER_BOX_WIDTH = 0.5;

/** Field of view is clamped to a usable lens range. Below the first the frustum
 *  is so narrow that float precision in the projection starts to show; above the
 *  second the distortion is a fisheye and straight edges bow past recognition.
 *  Expressed in radians because that is how the pose stores an angle. */
const MIN_FOV = 5 * (Math.PI / 180);
const MAX_FOV = 150 * (Math.PI / 180);

/**
 * Pure function. The pose after an ORBIT drag of (dLocalX, dLocalY) local px in a
 * `boxW`-wide box: yaw and pitch turn, everything else is untouched. The sign is
 * the grab-the-world convention every 3D tool uses — drag right and the subject
 * turns to follow your hand, which means the CAMERA goes the other way.
 *
 * Pitch is NOT clamped here; the widget's own `writes` clamps it, because the
 * limit is a property of what a pose can represent rather than of this gesture
 * (an `=` equation past the pole must be clamped identically).
 *
 * @param {object} pose the current pose
 * @param {number} dLocalX pointer travel, widget-local px
 * @param {number} dLocalY pointer travel, widget-local px
 * @param {number} boxW the widget's local box width
 * @returns {object} the next pose
 *
 * @example orbitedPose({yaw: 0, pitch: 0, roll: 0, distance: 3, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 200, 0, 400).yaw
 * // -1.5707963267948968   (half the box width is a quarter turn)
 * @example orbitedPose({yaw: 0, pitch: 0, roll: 0, distance: 3, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 0, 100, 400).pitch
 * // 0.7853981633974484
 * @example orbitedPose({yaw: 1, pitch: 0.2, roll: 0, distance: 3, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 0, 0, 400).yaw // 1
 */
export function orbitedPose(pose, dLocalX, dLocalY, boxW) {
  const perPx = (TURNS_PER_BOX_WIDTH * 2 * Math.PI) / Math.max(1, boxW);
  return { ...pose, yaw: pose.yaw - dLocalX * perPx, pitch: pose.pitch + dLocalY * perPx };
}

/**
 * Pure function. The pose after a DOLLY: the orbit distance scaled by the SAME
 * exponential law the canvas's own wheel zoom uses (src/lib/panZoomMath
 * expZoomFactor), so the two feels cannot drift. Scrolling "in" shortens the
 * radius, which is why the factor divides.
 *
 * @param {object} pose the current pose
 * @param {number} factor the zoom multiplier from expZoomFactor (> 0)
 * @returns {object} the next pose
 *
 * @example dollyedPose({yaw: 0, pitch: 0, roll: 0, distance: 4, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 2).distance // 2
 * @example dollyedPose({yaw: 0, pitch: 0, roll: 0, distance: 4, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 0.5).distance // 8
 */
export function dollyedPose(pose, factor) {
  return { ...pose, distance: pose.distance / Math.max(factor, Number.EPSILON) };
}

/**
 * How far one WASD step moves the camera, as a fraction of its orbit distance.
 * PROPORTIONAL, not absolute: a splat of a room and a splat of a coin are metres
 * and centimetres apart in scale, and a fixed step would either crawl in one or
 * teleport through the other. A tenth of the distance you are already standing at
 * is a step that feels the same in both.
 */
const FLY_STEP_FRACTION = 0.1;

/**
 * Pure function. The pose after ONE fly step — WASDQE, moving the camera through
 * the scene rather than turning it around a fixed point.
 *
 * User, 2026-08-02 (#270): "rollerball + WASD camera".
 *
 * ── IT MOVES THE TARGET, WHICH IS WHAT MAKES IT A FLY ───────────────────────
 * The camera is an ORBIT: an eye at `distance` from a target, at (yaw, pitch).
 * Turning is already the orbit; FLYING is translating the point being orbited.
 * Moving the target along the view axes carries the eye with it — so forward goes
 * forward, and the orbit you then perform is around the new place you have
 * arrived at. Changing the EYE instead would just have re-derived a turn.
 *
 * FORWARD IS THE FULL 3-D VIEW DIRECTION, pitch included, so looking down and
 * pressing forward descends — the behaviour every flying camera has. The strafe
 * axis is deliberately HORIZONTAL (it ignores pitch), because a strafe that
 * tilted with the look would roll the world sideways under the author; and
 * up/down is world-vertical for the same reason. That asymmetry is the
 * conventional one, not an oversight.
 *
 * @param {object} pose - the current pose ({targetX, targetY, targetZ, yaw, pitch, distance})
 * @param {{forward?: number, right?: number, up?: number}} step - unit steps, signed
 * @returns {object} the next pose
 *
 * @example // one step forward from the origin, looking down -Z:
 * // flownPose({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 10}, {forward: 1}).targetZ // -1
 * @example // strafing right is horizontal even when pitched down:
 * // flownPose({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: -1, distance: 10}, {right: 1}).targetY // 0
 * @example flownPose({targetX: 5, targetY: 5, targetZ: 5, yaw: 0, pitch: 0, distance: 10}, {}) // unchanged position
 */
export function flownPose(pose, { forward = 0, right = 0, up = 0 } = {}) {
  const step = Math.max(pose.distance, Number.EPSILON) * FLY_STEP_FRACTION;
  const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  // Forward: the unit view direction, matching orbitEye's convention.
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  // Right: the horizontal perpendicular, pitch deliberately ignored.
  const rx = cy, rz = -sy;
  return {
    ...pose,
    targetX: pose.targetX + step * (forward * fx + right * rx),
    targetY: pose.targetY + step * (forward * fy + up),
    targetZ: pose.targetZ + step * (forward * fz + right * rz),
  };
}

/**
 * THE FLY KEYS, as {keys, label, verb} — declared here beside the pose maths they
 * drive, surfaced by web/widget_handlers.canvasModes and turned into real
 * dispatching entries by core/shortcut_entries.js, exactly the way a mode's
 * `finish` key already is.
 *
 * THEY GO THROUGH THE SHORTCUT REGISTRY RATHER THAN A KEYDOWN HERE because the
 * manifest is explicit that the registry BOTH dispatches and feeds the HintBar:
 * "a shortcut that isn't registered there does not exist". A private listener
 * would fly the camera and leave the bottom bar silent about it.
 */
export const SCENE_FLY_KEYS = [
  { keys: ["W"], label: "Fly forward", verb: { forward: 1 } },
  { keys: ["S"], label: "Fly back", verb: { forward: -1 } },
  { keys: ["A"], label: "Strafe left", verb: { right: -1 } },
  { keys: ["D"], label: "Strafe right", verb: { right: 1 } },
  { keys: ["E"], label: "Rise", verb: { up: 1 } },
  { keys: ["Q"], label: "Descend", verb: { up: -1 } },
];

/**
 * Pure function. The pose after a FIELD-OF-VIEW change, clamped to a usable lens
 * range. Paired with Ctrl+wheel because the canvas's own Ctrl+wheel is zoom, so
 * the modifier means the same thing one frame down. Holding Distance and changing
 * this is the dolly-zoom.
 *
 * @param {object} pose the current pose
 * @param {number} factor the multiplier from expZoomFactor (> 0)
 * @returns {object} the next pose
 *
 * @example fovedPose({yaw: 0, pitch: 0, roll: 0, distance: 3, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 2).fov // 0.5
 * @example fovedPose({yaw: 0, pitch: 0, roll: 0, distance: 3, fov: 1, targetX: 0, targetY: 0, targetZ: 0}, 1000).fov // 0.08726646259971647
 */
export function fovedPose(pose, factor) {
  return { ...pose, fov: Math.max(MIN_FOV, Math.min(MAX_FOV, pose.fov / Math.max(factor, Number.EPSILON))) };
}

/**
 * Query (reads the document through `app`). The camera properties of `node` that
 * are bound to an `=` equation, as stored keys. Empty when none are.
 *
 * The write set is asked of the plugin at the node's CURRENT state, which is the
 * only way to know which keys a gesture would touch.
 *
 * THE HAND-BACK THIS COMMENT USED TO ANNOUNCE IS RESOLVED (R6-28). It said the
 * duplication with interiorNav.equationBoundInteriorProps was "KNOWN AND
 * TEMPORARY" and named itself the marker for whoever fixed it — correctly, and it
 * was right to defer rather than reach into two shipped widgets' file mid-round.
 * The shared half now lives in web/canvas/equationBinding.js equationBoundKeys,
 * with FIVE callers; what stays here is the one genuinely local line, the CAMERA
 * write set. tests/equation_lock_test.js fails if a sixth copy appears — this
 * function is where the gate caught the fifth.
 *
 * The write set is still asked of the plugin at the node's CURRENT state, which is
 * the only way to know which keys a gesture would touch.
 *
 * @param {object} app the app store
 * @param {object} node a derived render node
 * @returns {string[]} bound state keys, in write-set order
 */
export function equationBoundCameraProps(app, node) {
  const cam = node.plugin.sceneCamera;
  const keys = Object.keys(cam.writes(node.state, cam.pose(node.state)));
  return equationBoundKeys(app, node.itemId, node.plugin, keys);
}

/**
 * Command. Stages `pose` as a live preview of the item's camera properties —
 * DOCUMENT UNCHANGED, no undo entry. Every key of the plugin's write set is
 * written on every call, because setPreview REPLACES previewDelta wholesale.
 *
 * @param {object} app the app store
 * @param {object} node a derived render node (its plugin declares sceneCamera)
 * @param {object} pose the new camera pose
 */
export function previewScenePose(app, node, pose) {
  const writes = node.plugin.sceneCamera.writes(node.state, pose);
  app.setPreview(Object.entries(writes).map(([key, value]) => [["items", node.itemId, key], value]));
}

/**
 * THE HANDLER. Registered in web/widget_handlers.js; a widget opts in with
 * `activate: "navigate_scene"` plus its `sceneCamera` descriptor.
 */
export const NAVIGATE_SCENE_HANDLER = {
  id: "navigate_scene",
  phase: "activate",
  label: "Fly the camera",
  /** Pure function. `sceneCamera` is this handler's CONTENT descriptor, so a
   * widget declaring one wants this trigger. Read ONLY by
   * widget_handlers.migrationPlan — a widget that ships the descriptor but
   * forgets the `activate` string fails the suite rather than losing the mode.
   * @example NAVIGATE_SCENE_HANDLER.claims({sceneCamera: {}}) // true
   * @example NAVIGATE_SCENE_HANDLER.claims({type: "rect"}) // false */
  claims(plugin) {
    return !!plugin.sceneCamera;
  },
  /**
   * Command. Enters MOUSE-LOOK on the double-clicked viewport.
   *
   * REFUSES (loudly, no state change) when any camera property is bound to an `=`
   * equation. A `camYaw` bound to "= 2 * pi * progress" is a legitimate authored
   * fly-through, and a mouse drag must not silently replace it with the number it
   * currently evaluates to. This is the ruling beginTextEdit made first and
   * interiorNav applied second, applied here third rather than reinvented.
   */
  run(ctx) {
    const bound = equationBoundCameraProps(ctx.app, ctx.node);
    if (bound.length) {
      console.warn(`Fly the camera: ${bound.map((k) => `"${k}"`).join(", ")} ${bound.length === 1 ? "is an" : "are"} = equation${bound.length === 1 ? "" : "s"} — flying would overwrite ${bound.length === 1 ? "it" : "them"} with the current value. Clear the equation in the Inspector to fly this camera by hand, or keep the binding and animate the shot through the equation.`);
      return;
    }
    ctx.app.selection = ctx.node.itemId;
    // The visible indication that the mode is live, plus the live camera readout
    // — the widget's OWN declared floatingToolbar, mounted in the general canvas
    // panel every on-canvas bar uses.
    ctx.showOverlayPalette(ctx.node.itemId);
    ctx.enterMode();
  },
  /**
   * THE SUSTAINED MODE: while it is active the viewport owns canvas input. The
   * host (web/CanvasView.svelte) routes gestures here and App.svelte surfaces
   * `hints` in the HintBar, scoped to this mode's id. The host commits on
   * pointer-up and after ZOOM_GESTURE_IDLE_MS of wheel quiet, so one gesture is
   * one undo unit.
   */
  mode: {
    label: "Fly the camera",
    // The FLY keys ride `keys`, not `hints`: a hint is display-only, and these
    // must actually dispatch. canvasModes surfaces the field and
    // core/shortcut_entries.js supplies the `run` (it holds `app`; this file does
    // not), the same division the `finish` key already uses.
    keys: SCENE_FLY_KEYS,
    hints: [
      { keys: ["mouse_left"], label: "Look around" },
      { keys: ["mouse_scroll"], label: "Move closer / further" },
      { keys: ["Ctrl", "mouse_scroll"], label: "Field of view" },
    ],
    /**
     * THE POINTER IS CAPTURED FOR THE LENGTH OF A LOOK (todo #254 — "it didn't
     * capture my mouse and didn't let me go into mouse lock"). One boolean; the
     * host (web/CanvasView.svelte modePointerDown) takes the lock on press and
     * gives it back on release, and converts the travel from movementX/Y because
     * a locked pointer's client coordinates are frozen.
     *
     * WHY THE CAPTURE IS PER-DRAG AND NOT A PERSISTENT FPS-STYLE LOCK, which is
     * the other reading of "mouse lock" and is a real fork rather than an
     * oversight. A persistent lock hides the cursor for the WHOLE PAGE until
     * Escape, which would make this mode's own floating camera bar — the fields
     * that read out and edit the pose, and the only visible sign the mode is live
     * — unreachable without leaving the mode first. It would also put a second
     * meaning on Escape inside one mode (release the pointer, then exit the
     * mode), and an Escape that does two things at two moments is a defect this
     * app has shipped twice. Per-drag capture delivers the part that was actually
     * missing: the look no longer stops at the edge of the window and the cursor
     * no longer walks away from the widget it is steering. The persistent variant
     * is a deliberate open question, recorded rather than silently decided.
     *
     * NO NEW HINT CHIP, AND THAT IS THE CORRECT CALL RATHER THAN AN OMISSION. The
     * HintBar announces INPUTS, and this adds none: `mouse_left → Look around` is
     * still the whole gesture and is still exactly true. A chip reading "pointer
     * captured" would announce a STATE, and would be a lie in the one case that
     * matters — a browser is allowed to refuse the lock, and does so routinely
     * right after an Escape. The refusal is reported instead, in the console,
     * where a condition the user cannot act on visually belongs.
     */
    pointerLock: true,
    /**
     * Command. THE DRAG — orbit. Deltas arrive already converted to the widget's
     * LOCAL px frame, so a rotated or scaled viewport flies along its own axes.
     * They arrive in that frame whether the pointer is CAPTURED or not (see
     * `pointerLock` above): the host does the conversion, so this function cannot
     * tell the two apart and has no reason to.
     *
     * Reads the pose from the node's CURRENT state (preview included), so
     * successive ticks of one drag accumulate into ONE undo unit.
     *
     * NO TRUCK GESTURE IN THIS VERSION, and the reason is a host bound rather
     * than a choice: `onPan`'s payload is `{dLocalX, dLocalY}` and carries no
     * modifier keys (web/CanvasView.svelte:1162), and NO mode in this app has
     * ever received one — `onPick`/`onHover` do not either. Advertising a
     * Shift+drag hint that cannot fire would be exactly the HintBar lie the
     * shortcut registry exists to prevent, so the target is moved through the
     * Inspector's Target X/Y/Z rows for now. Adding `shiftKey: e.shiftKey` to
     * that one payload is a host capability addition, handed back rather than
     * taken unilaterally.
     */
    onPan(ctx, { dLocalX, dLocalY }) {
      const { node } = ctx;
      const pose = node.plugin.sceneCamera.pose(node.state);
      previewScenePose(ctx.app, node, orbitedPose(pose, dLocalX, dLocalY, node.state.w ?? 1));
    },
    /**
     * Command. THE WHEEL, read exactly as src/lib/PanZoom.svelte reads it for the
     * canvas: `ctrlKey` (what a trackpad PINCH sends) is the zoom modifier, and
     * anything else is the plain gesture. One frame down that means Ctrl+wheel
     * changes the LENS and a plain wheel changes the DISTANCE.
     */
    onWheel(ctx, { deltaY, ctrlKey }) {
      const { node } = ctx;
      const pose = node.plugin.sceneCamera.pose(node.state);
      const factor = expZoomFactor(deltaY);
      previewScenePose(ctx.app, node, ctrlKey ? fovedPose(pose, factor) : dollyedPose(pose, factor));
    },
  },
};

// Re-exported so a reader of this file can see the commit rule without chasing
// interiorNav: a wheel has no "up" event, so a zoom gesture ends on a pause of
// this length and that pause is what makes it ONE undo unit.
export { ZOOM_GESTURE_IDLE_MS };
