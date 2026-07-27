/**
 * panZoomMath.js — THE pan/zoom laws, as pure functions.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 * These are the arithmetic of a viewport: the exponential wheel-zoom factor, the
 * screen↔world maps, zoom-about-a-point, pan, and the two-finger pinch. They lived
 * in `PanZoom.svelte`'s component script, correctly labelled "Pure math (general)"
 * — and unexported, because a `<script>` block in a Svelte component cannot export
 * anything. So every OTHER surface that needed the same feel re-typed them, and
 * `expZoomFactor` reached THREE independent copies (PanZoom, AnnotateBar's
 * timeline, and PowerRP's interior-explore navigator, the last one carrying its
 * own restatement of the 0.01 sensitivity as well). Three copies of one law is how
 * two of them come to disagree about how far a scroll should zoom.
 *
 * Now: ONE definition here, imported by all of them. `PanZoom.svelte` is still THE
 * viewport controller — it owns the state, the events and the animation; this file
 * owns only the arithmetic it was already documenting as general.
 *
 * ── THE VIEWPORT ─────────────────────────────────────────────────────────────
 * A viewport is `{zoom, panX, panY}` and the mapping is
 *
 *     screen = world · zoom + pan
 *
 * so `zoom` is screen px per world unit and `pan` is where world origin lands.
 * Everything below is that one line, solved for something.
 *
 * No DOM, no framework: plain pure functions with runnable examples.
 */

/**
 * THE wheel-zoom sensitivity: the exponent scale in the 2^(-deltaY·s) law, and the
 * feel every zoomable surface in the library shares.
 *
 * WHY THIS VALUE. It makes 100 units of wheel delta — one notch on a mouse wheel,
 * or a short trackpad pinch — exactly a factor of two. That is a step you can
 * predict and undo by scrolling back the same amount, which a non-power-of-two
 * rate is not.
 */
export const ZOOM_SENSITIVITY = 0.01;

/**
 * Pure function. Exponential zoom factor for a wheel delta: 2^(-deltaY·sensitivity).
 *
 * EXPONENTIAL AND NOT LINEAR because zoom is multiplicative — the same scroll must
 * mean "twice as big" whether you are at 0.1x or at 1000x, and a linear rate would
 * crawl at one end and jump at the other. Negative delta (scroll up / pinch out)
 * magnifies, matching every platform's convention.
 *
 * @param {number} deltaY - WheelEvent deltaY (positive = scroll down)
 * @param {number} [sensitivity] - exponent scale
 * @returns {number} a multiplier on the view zoom (> 0)
 *
 * @example expZoomFactor(0) // 1 (no change)
 * @example expZoomFactor(-100) // 2 (scroll up magnifies)
 * @example expZoomFactor(100) // 0.5 (scroll down shrinks)
 * @example expZoomFactor(-200) // 4 (two notches = two doublings)
 */
export function expZoomFactor(deltaY, sensitivity = ZOOM_SENSITIVITY) {
  return Math.pow(2, -deltaY * sensitivity);
}

/**
 * Pure function. Clamp a value to [min, max].
 *
 * @example clamp(0.5, 1, 100) // 1
 * @example clamp(50, 1, 100) // 50
 * @example clamp(200, 1, 100) // 100
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure function. Screen coords → world coords: (screen - pan) / zoom.
 *
 * @param {number} screenX
 * @param {number} screenY
 * @param {{zoom: number, panX: number, panY: number}} vp - the viewport
 * @returns {{x: number, y: number}}
 *
 * @example screenToWorldPure(100, 100, {zoom: 2, panX: 50, panY: 50}) // {x: 25, y: 25}
 * @example screenToWorldPure(0, 0, {zoom: 1, panX: 0, panY: 0}) // {x: 0, y: 0}
 */
export function screenToWorldPure(screenX, screenY, vp) {
  return {
    x: (screenX - vp.panX) / vp.zoom,
    y: (screenY - vp.panY) / vp.zoom,
  };
}

/**
 * Pure function. World coords → screen coords: world · zoom + pan.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {{zoom: number, panX: number, panY: number}} vp - the viewport
 * @returns {{x: number, y: number}}
 *
 * @example worldToScreenPure(25, 25, {zoom: 2, panX: 50, panY: 50}) // {x: 100, y: 100}
 * @example worldToScreenPure(0, 0, {zoom: 3, panX: -10, panY: 7}) // {x: -10, y: 7}
 */
export function worldToScreenPure(worldX, worldY, vp) {
  return {
    x: worldX * vp.zoom + vp.panX,
    y: worldY * vp.zoom + vp.panY,
  };
}

/**
 * Pure function. THE zoom-about-a-point identity: a new viewport at `newZoom` in
 * which the WORLD point currently under (screenX, screenY) is still under it. Solve
 * screen = world·zoom + pan for pan at the new zoom, holding both sides fixed.
 *
 * @param {number} screenX - the anchor, screen px
 * @param {number} screenY - the anchor, screen px
 * @param {number} newZoom - the zoom to end at
 * @param {{zoom: number, panX: number, panY: number}} vp - the viewport
 * @returns {{zoom: number, panX: number, panY: number}}
 *
 * @example zoomTowards(100, 100, 2, {zoom: 1, panX: 0, panY: 0}) // {zoom: 2, panX: -100, panY: -100}
 * @example zoomTowards(0, 0, 5, {zoom: 1, panX: 0, panY: 0}) // {zoom: 5, panX: 0, panY: 0} (the origin corner stays put)
 */
export function zoomTowards(screenX, screenY, newZoom, vp) {
  const world = screenToWorldPure(screenX, screenY, vp);
  return {
    zoom: newZoom,
    panX: screenX - world.x * newZoom,
    panY: screenY - world.y * newZoom,
  };
}

/**
 * Pure function. A viewport panned by a SCREEN delta. The content follows the
 * gesture, so a positive scroll delta moves the view forward and the pan back.
 *
 * @param {{zoom: number, panX: number, panY: number}} vp - the viewport
 * @param {number} deltaX - screen px
 * @param {number} deltaY - screen px
 * @returns {{zoom: number, panX: number, panY: number}}
 *
 * @example pan({zoom: 1, panX: 0, panY: 0}, 10, 20) // {zoom: 1, panX: -10, panY: -20}
 * @example pan({zoom: 2, panX: 5, panY: 5}, 0, 0) // {zoom: 2, panX: 5, panY: 5}
 */
export function pan(vp, deltaX, deltaY) {
  return { zoom: vp.zoom, panX: vp.panX - deltaX, panY: vp.panY - deltaY };
}

/**
 * Pure function. Euclidean distance between two touch points.
 *
 * @example touchDistance({clientX: 0, clientY: 0}, {clientX: 3, clientY: 4}) // 5
 * @example touchDistance({clientX: 7, clientY: 7}, {clientX: 7, clientY: 7}) // 0
 */
export function touchDistance(t1, t2) {
  const dx = t2.clientX - t1.clientX;
  const dy = t2.clientY - t1.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Pure function. Midpoint of two touches, relative to an element rect.
 *
 * @example touchMidpoint({clientX: 0, clientY: 0}, {clientX: 100, clientY: 100}, {left: 0, top: 0}) // {x: 50, y: 50}
 * @example touchMidpoint({clientX: 20, clientY: 40}, {clientX: 40, clientY: 80}, {left: 10, top: 10}) // {x: 20, y: 50}
 */
export function touchMidpoint(t1, t2, rect) {
  return {
    x: (t1.clientX + t2.clientX) / 2 - rect.left,
    y: (t1.clientY + t2.clientY) / 2 - rect.top,
  };
}

/**
 * Pure function. The viewport for a two-finger PINCH, measured from the gesture's
 * START pose rather than integrated per move — so a pinch that returns to its
 * initial spread returns to the initial zoom exactly, with no accumulated drift.
 * The world point under the initial midpoint ends up under the CURRENT midpoint,
 * which is what makes a pinch pan and zoom at once.
 *
 * @param {{initialDist: number, initialZoom: number, initialPanX: number, initialPanY: number, initialMidX: number, initialMidY: number}} pinch - the gesture-start pose
 * @param {number} currentDist - the live finger spread
 * @param {{x: number, y: number}} currentMid - the live midpoint, element px
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {{zoom: number, panX: number, panY: number}}
 *
 * @example calcPinchZoom({initialDist: 100, initialZoom: 1, initialPanX: 0, initialPanY: 0, initialMidX: 50, initialMidY: 50}, 200, {x: 50, y: 50}, 0.1, 10) // {zoom: 2, panX: -50, panY: -50} (spread doubled about a still midpoint)
 * @example calcPinchZoom({initialDist: 100, initialZoom: 1, initialPanX: 0, initialPanY: 0, initialMidX: 50, initialMidY: 50}, 100, {x: 70, y: 50}, 0.1, 10) // {zoom: 1, panX: 20, panY: 0} (no spread change = a pure two-finger pan)
 */
export function calcPinchZoom(pinch, currentDist, currentMid, minZoom, maxZoom) {
  const zoomDelta = currentDist / pinch.initialDist;
  const newZoom = clamp(pinch.initialZoom * zoomDelta, minZoom, maxZoom);
  const world = screenToWorldPure(pinch.initialMidX, pinch.initialMidY, {
    zoom: pinch.initialZoom,
    panX: pinch.initialPanX,
    panY: pinch.initialPanY,
  });
  return {
    zoom: newZoom,
    panX: currentMid.x - world.x * newZoom,
    panY: currentMid.y - world.y * newZoom,
  };
}

/**
 * Pure function. Ease-out cubic — the animation curve the viewport transitions use
 * (fast departure, gentle arrival, which reads as "the view settled" rather than
 * "the view stopped").
 *
 * @example easeOutCubic(0) // 0
 * @example easeOutCubic(1) // 1
 * @example easeOutCubic(0.5) // 0.875
 */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
