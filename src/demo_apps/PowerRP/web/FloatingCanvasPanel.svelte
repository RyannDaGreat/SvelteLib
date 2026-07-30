<!--
  FloatingCanvasPanel — THE floating canvas surface. One positioned shell that
  every on-canvas popover sits in: the cursor grid (CanvasToolbar), the selected-
  handle tools (HandleToolbar), and any future coordinate/format bar. It renders a
  `children` snippet and owns NOTHING about the content.

  ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
  These bars were multiplying, and each copy re-derived the same four decisions —
  three of which are load-bearing and one of which is a trap. Extracting the SHELL
  (and only the shell) is what stops the fifth copy from getting one of them wrong.

  ── WHY web/ AND NOT src/lib ─────────────────────────────────────────────────
  A src/lib component must be app-agnostic and, per SvelteLib's own CLAUDE.md,
  "style themselves internally (scoped <style>) and don't depend on the theme". This
  panel is the opposite of both: its whole job is to look like PowerRP chrome (it is
  styled from app.css through --a-* tokens, the app convention), and it is placed in
  the render-area screen frame produced by THIS app's camera map. There is
  deliberately NO src/lib primitive underneath it either — strip the placement and
  the theming and the residue is an empty div, and an empty abstraction is worse
  than none. Do not add one.

  ── THE FIVE DECISIONS IT OWNS ───────────────────────────────────────────────
  1. PLACEMENT in the render-area screen frame: horizontally centred on `x`, with
     its bottom edge on `topY` so it hangs ABOVE the thing it belongs to.
  2. THE FLIP. Near the top of the viewport the panel would be clipped, so it
     re-pins to `bottomY` and hangs DOWN instead. The threshold is read from the
     --a-canvas-toolbar-max-h CSS token, so the flip decision and the CSS height cap
     have ONE source of truth and no magic px lives here.
  3. IT MUST NOT STEAL THE CANVAS GESTURE UNDERNEATH IT. The root is a zero-footprint
     `pointer-events: none` anchor; only the panel itself takes pointer events. A
     full-size transparent wrapper would swallow drags on the widget it is describing.
  4. NO TRANSFORM ON THE PANEL — the trap. The content's hover Tooltips render
     `position: fixed`, and ANY transformed ancestor becomes the containing block for
     fixed descendants, which offsets every tip by the panel's own origin (measured:
     a tip due at (622,262) landed at (1202,494) = panel origin + intended). So the
     centring comes from flex alignment, never translate(-50%, …). See the matching
     note in app.css at .canvas-toolbar-root.
  5. THE WHEEL BELONGS TO THE PANEL, NEVER TO THE CANVAS BEHIND IT. See onWheel.

  Styling lives in app.css under the EXISTING .canvas-toolbar-* class names (the
  app convention: no <style> block here, every colour/size from an --a-* token) —
  deliberately not a second set of tokens for a second name.
-->
<script module>
  import * as T from "../core/transform.js";

  /**
   * Pure function. The panel anchor for a WIDGET's bounding box: centred on the
   * box's top edge, flipping to its bottom edge. THE common case, shared so a
   * consumer that just wants "above this widget" writes no transform math — and so
   * two consumers cannot disagree about where "above this widget" is.
   *
   * Goes through node.world (never the raw state x/y), so a rotated or scaled
   * widget anchors to the pose actually on screen — the rotation-audit lesson.
   *
   * @param {object} node - a derived render node ({state, world})
   * @param {(wx: number, wy: number) => {x: number, y: number}} worldToScreen - the camera map
   * @returns {{x: number, topY: number, bottomY: number}} render-area screen px
   *
   * @example // an unrotated 100x40 box at (10, 200), identity camera:
   * @example widgetPanelAnchor({state: {w: 100, h: 40}, world: {x: 10, y: 200, rotation: 0, scale: 1}}, (x, y) => ({x, y})) // {x: 60, topY: 200, bottomY: 240}
   */
  export function widgetPanelAnchor(node, worldToScreen) {
    const w = node.state.w ?? 0, h = node.state.h ?? 0;
    const t = T.apply(node.world, w / 2, 0), b = T.apply(node.world, w / 2, h);
    const top = worldToScreen(t.x, t.y), bottom = worldToScreen(b.x, b.y);
    return { x: top.x, topY: top.y, bottomY: bottom.y };
  }

  /** Fallback for --a-canvas-toolbar-max-h when there is no computed style to read
   *  (a non-DOM render path). Matches the token's committed value. */
  const MAX_H_FALLBACK = 296;

  /** Query. A CSS custom-property length (px) resolved off :root, or a fallback.
   * @example cssPx("--a-canvas-toolbar-max-h", 296) // 296 (when unset)
   */
  function cssPx(name, fallback) {
    if (typeof getComputedStyle === "undefined") return fallback;
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  }

  /**
   * Query. Is there a VERTICALLY SCROLLABLE box between `from` and `stop`
   * (inclusive of `from`, exclusive of `stop`) that can still move by `deltaY`?
   *
   * The point is to answer "will the browser's own scrolling do something useful
   * with this wheel event", so `preventDefault` can be withheld in exactly that
   * case and applied otherwise. Both halves matter: overflow must permit scrolling
   * AND the box must not already be pinned at the end the wheel pushes toward — a
   * grid scrolled to its bottom cannot consume another downward notch, and if we
   * left that event alive it would scroll-chain out to the canvas.
   *
   * @param {Element|null} from - the wheel's target (walked upward)
   * @param {Element|null} stop - the ancestor to stop at (the panel root)
   * @param {number} deltaY - the wheel's vertical delta; sign selects the end to test
   * @returns {boolean}
   *
   * @example // a 296px-tall grid with 418px of tiles, scrolled to the top, wheeled down:
   * @example // canScrollVertically(tileImg, panelEl, 120) // true — the grid takes it
   * @example // …the same grid scrolled to its bottom: canScrollVertically(tileImg, panelEl, 120) // false
   * @example // the search input (no overflow anywhere below the panel): // false
   */
  function canScrollVertically(from, stop, deltaY) {
    for (let el = from; el && el !== stop; el = el.parentElement) {
      if (!(el instanceof Element)) break;
      const style = getComputedStyle(el);
      const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
      if (!scrolls || el.scrollHeight <= el.clientHeight) continue;
      const room = deltaY > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
      if (room > 1) return true; // sub-pixel slack is not room
    }
    return false;
  }
</script>

<script>
  // x/topY/bottomY = the anchor in render-area screen px (widgetPanelAnchor builds
  // the widget-box case). `label` names the surface for assistive tech. `children`
  // is the content snippet — this component has no opinion about it.
  let { x, topY, bottomY, label, children } = $props();

  // Would the above-hanging panel be clipped by the top of the render area? Then
  // hang it below instead. Read from the token that caps the panel's height, so the
  // decision cannot drift from the CSS.
  let below = $derived(topY < cssPx("--a-canvas-toolbar-max-h", MAX_H_FALLBACK));

  let panelEl = $state(null); // the panel box — the upper bound of the wheel walk

  /**
   * Command. THE WHEEL OVER A FLOATING PANEL BELONGS TO THE PANEL.
   *
   * The bug this fixes, reported verbatim: "I need to be able to scroll… it's not
   * capturing my mouse scroll wheel, it's just depending on zooming when I use it."
   * Every floating panel mounts INSIDE CanvasView's PanZoom subtree, and
   * src/lib/PanZoom.svelte binds a bubble-phase `onwheel` on its container that
   * unconditionally `preventDefault()`s and then pans (plain wheel) or zooms
   * (ctrl/pinch). So a wheel over the iconify palette did BOTH wrong things at
   * once: the canvas moved, and the grid did not scroll — the preventDefault
   * killed the native scroll the grid's own `overflow-y: auto` would have done.
   * MEASURED at baseline: four downward notches over a 296px grid holding 418px of
   * tiles left scrollTop at 0 and moved the canvas panY 0 → -480; one ctrl+wheel
   * took zoom 1 → 5.28 and threw the widget (and its palette) off screen.
   *
   * Fixed HERE, in the shell, rather than in CanvasToolbar: it is the panel's
   * placement inside the PanZoom subtree that causes this, so every panel that
   * shell hosts has the bug and every one of them is cured by one handler. A
   * per-content fix would be the fifth copy of a decision this component exists to
   * own (see THE FIVE DECISIONS above).
   *
   * TWO PARTS, and both are load-bearing:
   *   stopPropagation ALWAYS — the event must never reach PanZoom's container.
   *     This alone is what makes the canvas hold still.
   *   preventDefault ONLY when nothing under the pointer can scroll. Over the grid
   *     we must NOT preventDefault, or we would reintroduce exactly the half of the
   *     bug that kept the grid frozen; native scrolling is what moves it. Over the
   *     search bar — or over a grid already pinned at the end the wheel pushes
   *     toward — there is nothing to scroll, and leaving the event alive lets the
   *     browser scroll-chain it outward to an ancestor. This is the FontPicker's
   *     onWheel ruling (web/FontPicker.svelte), generalised from "is the target in
   *     the one known list" to "can anything between here and the panel take it",
   *     because a panel may hold several scroll boxes and the shell knows none of them.
   */
  /** Query. Does this panel contain ANY scrollable box at all? A panel with no
   * scrollable content (a button row like the paint-path handle bar, a fields
   * readout) has no claim on the wheel — the user's ruling: "that's not a
   * scrollable region; only the scrollable regions need to block scroll". */
  function panelHasScrollBox() {
    for (const el of panelEl.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight)
        return true;
    }
    return false;
  }

  /** Command. The wheel policy, three tiers:
   *  1. a scroll box under the cursor with room → capture, native scroll takes it;
   *  2. no room here but the panel HAS scrollable content somewhere → capture
   *     and eat (wheeling over a scrolly palette's search bar or a pinned list
   *     must not surprise-zoom the canvas);
   *  3. the panel has NO scrollable content at all → fall through untouched, so
   *     the canvas pans/zooms exactly as if the pointer were on bare canvas. */
  function onWheel(e) {
    if (canScrollVertically(e.target, panelEl, e.deltaY)) {
      e.stopPropagation();
      return;
    }
    if (panelHasScrollBox()) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
</script>

<div
  class="canvas-toolbar-root"
  class:canvas-toolbar-below={below}
  style:left="{x}px"
  style:top="{below ? bottomY : topY}px"
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="canvas-toolbar" role="toolbar" aria-label={label} tabindex="-1" bind:this={panelEl} onwheel={onWheel}>
    {@render children()}
  </div>
</div>
