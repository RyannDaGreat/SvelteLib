<!--
  ResizeGrip — THE drag handle under a preset grid that makes it vertically resizable
  (user, 2026-09-30: "I wanna see all the pretty gradients at once but it won't let
  me. It only lets me see maybe two and a half rows at a time").

  ONE implementation for every preset library: the gradient/Multipoint/recolour
  libraries (GradientPresetPicker), the floating canvas palettes (CanvasToolbar) and
  the brush textures (BrushPalette). The mount point renders this directly after its
  scrolling grid and hands it the grid element plus a library KIND; the rules (clamp,
  size modes, persistence, room inside a floating panel) live in web/gridResize.js.

  Gestures: drag = any height from about one row up to the whole content;
  double-click = toggle compact ⇄ show all; keyboard (it is focusable) ArrowUp/Down
  step one row, Home = compact, End = show all, Enter = toggle.

  No <style> block (web/ app convention): .resize-grip / .resize-grip-bar in app.css.
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import {
    GRID_SHOW_ALL, clampGridHeight, readGridHeight, writeGridHeight, applyGridHeight,
    gridRowMinimum, gridMaximum,
  } from "./gridResize.js";

  let { target = null, kind, label = "preset grid" } = $props();
  const HELP = "Drag to resize · double-click: show all / compact";
  // A drag that ends within this many px of the whole content is stored as SHOW ALL,
  // so the grid keeps tracking its content (search filtering, a growing library).
  const SHOW_ALL_SNAP_PX = 2;
  // Pointer travel below this is a click, not a resize (see onPointerUp).
  const CLICK_SLOP_PX = 3;

  let drag = null; // {startY, startH, min, max} while a pointer drag is live

  // Restore this kind's stored size whenever the grid (re)mounts — a library that
  // was closed and reopened comes back at the height the user left it.
  $effect(() => {
    if (target) applyGridHeight(target, readGridHeight(kind));
  });

  /**
   * Command. Applies AND stores a size mode for this kind.
   * @param {number|"all"|null} mode - px, show-all, or compact.
   */
  function setMode(mode) {
    applyGridHeight(target, mode);
    writeGridHeight(kind, mode);
  }

  /**
   * Pure function. The mode a finished drag should store.
   * @param {number} height - Final dragged height, px.
   * @param {number} content - The grid's whole content height, px.
   * @returns {number|"all"} GRID_SHOW_ALL when the drag reached the content, else px.
   * @example modeForDrag(640, 641) // "all"
   * @example modeForDrag(300, 641) // 300
   */
  function modeForDrag(height, content) {
    return height >= content - SHOW_ALL_SNAP_PX ? GRID_SHOW_ALL : Math.round(height);
  }

  /** Command. Starts a drag; the grip captures the pointer so the gesture survives leaving it. */
  function onPointerDown(e) {
    if (!target || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // never a canvas pan/marquee under a floating panel
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { startY: e.clientY, startH: target.getBoundingClientRect().height,
      min: gridRowMinimum(target), max: gridMaximum(target) };
  }

  /** Command. Resizes the grid live while dragging (not stored until release). */
  function onPointerMove(e) {
    if (!drag) return;
    applyGridHeight(target, clampGridHeight(drag.startH + e.clientY - drag.startY, drag.min, drag.max));
  }

  /** Command. Ends a drag and stores where it landed. A press that never MOVED is a
   * click (half of a double-click), not a resize: it stores nothing, or the toggle
   * would always find a stored height and could never reach show-all from compact. */
  function onPointerUp(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const height = clampGridHeight(drag.startH + dy, drag.min, drag.max);
    drag = null;
    if (Math.abs(dy) < CLICK_SLOP_PX) {
      applyGridHeight(target, readGridHeight(kind));
      return;
    }
    setMode(modeForDrag(height, target.scrollHeight));
  }

  /** Command. Double-click: compact ⇄ show all. */
  function toggle() {
    if (!target) return;
    setMode(readGridHeight(kind) === null ? GRID_SHOW_ALL : null);
  }

  /** Command. Keyboard resizing for the focusable grip. */
  function onKeydown(e) {
    if (!target) return;
    const min = gridRowMinimum(target), max = gridMaximum(target);
    const now = target.getBoundingClientRect().height;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = clampGridHeight(now + (e.key === "ArrowDown" ? min : -min), min, max);
      setMode(modeForDrag(next, target.scrollHeight));
    } else if (e.key === "Home") setMode(null);
    else if (e.key === "End") setMode(GRID_SHOW_ALL);
    else if (e.key === "Enter") toggle();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<Tooltip text={HELP} anchor="element">
  <div
    class="resize-grip"
    role="separator"
    aria-orientation="horizontal"
    aria-label={`Resize ${label}`}
    tabindex="0"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={() => { drag = null; }}
    ondblclick={toggle}
    onkeydown={onKeydown}
  >
    <span class="resize-grip-bar"></span>
  </div>
</Tooltip>
