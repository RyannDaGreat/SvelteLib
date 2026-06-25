/**
 * drag.js — headless click-drag, as a Svelte action.
 *
 * Attaches press → drag → release tracking to an element and reports the gesture
 * through callbacks. It renders nothing and knows nothing about what's being
 * dragged — you feed the deltas wherever you want (e.g. into PanZoom's pan). It's
 * the drag half of "headless behaviour, you own the state", the same way PanZoom
 * owns the transform and hands it to its consumer.
 *
 * Each move reports BOTH the running delta from the press point (dx, dy) AND this
 * move's increment (mx, my). Increments are what you usually add to a pan.
 *
 * Configurable:
 *   - which button(s) start a drag: "left" | "middle" | "right", a list, or codes
 *   - an `enabled` gate so some OTHER condition can arm the drag (a held key, a
 *     mode flag) — pass a boolean or a () => boolean, re-read on every press
 *   - the cursor (grab when idle, grabbing while dragging; pass false to leave it)
 *
 * Usage:
 *   <div use:drag={{ onMove: ({ mx, my }) => view.panBy(mx, my) }}></div>
 *   <div use:drag={{ button: "middle", enabled: () => spaceHeld, onMove }}></div>
 *
 *   // a reactive boolean, if you want one — you own it:
 *   let dragging = $state(false);
 *   <div use:drag={{ onActive: (v) => (dragging = v), onMove }}></div>
 *
 * @typedef {Object} DragOptions
 * @property {("left"|"middle"|"right"|number)|Array<"left"|"middle"|"right"|number>} [button="left"]
 * @property {boolean | (() => boolean)} [enabled=true] Gate — a press only starts a drag when true.
 * @property {boolean} [cursor=true] Manage node.style.cursor (grab / grabbing).
 * @property {({x:number,y:number}) => void} [onStart]
 * @property {({dx:number,dy:number,mx:number,my:number,x:number,y:number}) => void} [onMove]
 * @property {({dx:number,dy:number}) => void} [onEnd]
 * @property {(active:boolean) => void} [onActive] Drag start (true) / end (false).
 */

const CODE = { left: 0, middle: 1, right: 2 };
const toCodes = (b) => [].concat(b ?? "left").map((x) => (typeof x === "number" ? x : CODE[x]));

/**
 * Svelte action. See module docs.
 * @param {HTMLElement} node
 * @param {DragOptions} options
 */
export function drag(node, options = {}) {
  let o = options;
  let buttons = toCodes(o.button);
  let active = false;
  let sx = 0, sy = 0, lx = 0, ly = 0, pointerId = -1;

  const armed = () => (typeof o.enabled === "function" ? o.enabled() : o.enabled ?? true);
  const setCursor = (c) => { if (o.cursor !== false) node.style.cursor = c; };
  setCursor("grab");

  function onDown(e) {
    if (active || !armed() || !buttons.includes(e.button)) return;
    active = true;
    sx = lx = e.clientX;
    sy = ly = e.clientY;
    pointerId = e.pointerId;
    node.setPointerCapture?.(pointerId);
    setCursor("grabbing");
    e.preventDefault();
    o.onStart?.({ x: e.clientX, y: e.clientY });
    o.onActive?.(true);
  }
  function onMove(e) {
    if (!active) return;
    const mx = e.clientX - lx, my = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    o.onMove?.({ dx: e.clientX - sx, dy: e.clientY - sy, mx, my, x: e.clientX, y: e.clientY });
  }
  function onUp(e) {
    if (!active) return;
    active = false;
    node.releasePointerCapture?.(pointerId);
    setCursor("grab");
    o.onEnd?.({ dx: e.clientX - sx, dy: e.clientY - sy });
    o.onActive?.(false);
  }

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);

  return {
    update(next) {
      o = next;
      buttons = toCodes(o.button);
      if (!active) setCursor("grab");
    },
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
      node.style.cursor = "";
    },
  };
}
