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

  ── THE FOUR DECISIONS IT OWNS ───────────────────────────────────────────────
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
</script>

<div
  class="canvas-toolbar-root"
  class:canvas-toolbar-below={below}
  style:left="{x}px"
  style:top="{below ? bottomY : topY}px"
>
  <div class="canvas-toolbar" role="toolbar" aria-label={label} tabindex="-1">
    {@render children()}
  </div>
</div>
