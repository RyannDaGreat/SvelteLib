<!--
  Tooltip [visual, general] — immediate hover/focus tooltip wrapper.

  Wraps its children and shows a small floating label. Unlike native `title`
  tooltips (which wait ~1s), this appears IMMEDIATELY on hover/focus by default.
  An optional `delay` (ms) reintroduces a hover-time threshold: the pointer must
  rest on the target that long before the tip shows.

  Anchoring differs by how it was triggered:
    - POINTER (hover): the tip is positioned NEAR THE MOUSE CURSOR, offset a
      small gap so it never sits under the pointer, and it tracks pointermove so
      it follows the cursor while hovered. This matters for large wrapped targets
      (e.g. a whole panel): anchoring to the element's bounding box would put the
      tip far from what you're pointing at.
    - FOCUS (keyboard): there is no cursor, so the tip anchors to the wrapped
      element's getBoundingClientRect instead.

  Positioned with fixed coordinates — no dependency on scroll containers or
  transforms. Placement is "top" or "bottom" (relative to the cursor or element);
  it flips automatically when the chosen side would clip the viewport, and is
  clamped horizontally so it never overflows. Hides on pointerleave, blur,
  Escape, and pointerdown (a click dismisses).

  Usage (immediate — default; tip appears next to the cursor):
    <Tooltip text="Save file">
      <button>Save</button>
    </Tooltip>

  Usage (delayed 500ms hover threshold — pass delay in ms):
    <Tooltip text="Details" delay={500}>
      <span>hover me</span>
    </Tooltip>

  Usage (rich content via the `tip` snippet instead of `text`):
    <Tooltip placement="bottom">
      {#snippet tip()}
        <strong>Bold</strong> tip with <em>markup</em>
      {/snippet}
      <button>info</button>
    </Tooltip>

  CSS custom properties (chain to ambient tokens, with standalone fallbacks):
    --tt-bg        background         (← --control-bg → rgba(0,0,0,0.9))
    --tt-fg        text color         (← --fg → #f0f0f0)
    --tt-border    border color       (← --border → rgba(255,255,255,0.15))
    --tt-radius    corner radius      (2px — square-ish; keep minimal)
    --tt-pad       padding            (4px 8px)
    --tt-font-size font size          (0.75rem)
    --tt-gap       offset from anchor (6px)
    --tt-max-width max content width  (240px)
-->
<script module>
  /**
   * Pure function. Builds a zero-size DOMRect-like reference box at a cursor
   * point, so the cursor path can reuse the same rect-based placement math as
   * the element path (which passes a real getBoundingClientRect).
   *
   * @param {number} x Cursor X in viewport coords.
   * @param {number} y Cursor Y in viewport coords.
   * @returns {{left:number,right:number,top:number,bottom:number}} Degenerate rect at (x, y).
   *
   * @example
   * // A cursor at (300, 200) becomes a zero-size box there.
   * pointRect(300, 200)
   * // => { left: 300, right: 300, top: 200, bottom: 200 }
   */
  export function pointRect(x, y) {
    return { left: x, right: x, top: y, bottom: y };
  }

  /**
   * Query. Returns the viewport rect of the anchor's real content, unioning its
   * element children. The anchor <span> is `display:contents`, so its own
   * getBoundingClientRect() is an empty box at (0,0) — useless for placement.
   * The wrapped control(s) carry the real geometry, so we union their rects.
   *
   * @param {Element} span The `display:contents` anchor span.
   * @returns {{left:number,right:number,top:number,bottom:number}|null} Union rect, or null if empty.
   *
   * @example
   * // A span wrapping one button at x∈[117,198], y∈[40,66]:
   * // anchorRect(span) // => { left: 117, right: 198, top: 40, bottom: 66 }
   * @example
   * // A span with no element children returns null (nothing to anchor to).
   * // anchorRect(emptySpan) // => null
   */
  export function anchorRect(span) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const child of span.children) {
      const r = child.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (left === Infinity) return null;
    return { left, top, right, bottom };
  }

  /**
   * Pure function. Chooses the final placement, flipping the requested side
   * when it would clip the viewport but the opposite side fits.
   *
   * @param {"top"|"bottom"} placement Requested side.
   * @param {{top:number,bottom:number}} rect Reference rect (viewport coords); a
   *   real element rect, or a degenerate cursor rect from `pointRect`.
   * @param {number} tipHeight Measured tooltip height in px.
   * @param {number} gap Offset between anchor and tooltip in px.
   * @param {number} viewH Viewport height in px.
   * @returns {"top"|"bottom"} The side actually used.
   *
   * @example
   * // "top" requested but no room above → flip to "bottom"
   * resolvePlacement("top", { top: 4, bottom: 24 }, 20, 6, 800)
   * // => "bottom"
   * @example
   * // "top" requested with plenty of room above → stays "top"
   * resolvePlacement("top", { top: 400, bottom: 420 }, 20, 6, 800)
   * // => "top"
   * @example
   * // "bottom" requested but clipped below, room above → flip to "top"
   * resolvePlacement("bottom", { top: 780, bottom: 796 }, 20, 6, 800)
   * // => "top"
   * @example
   * // Cursor near the top edge (degenerate rect): "top" flips to "bottom".
   * resolvePlacement("top", pointRect(500, 10), 20, 6, 800)
   * // => "bottom"
   */
  export function resolvePlacement(placement, rect, tipHeight, gap, viewH) {
    const fitsAbove = rect.top - gap - tipHeight >= 0;
    const fitsBelow = rect.bottom + gap + tipHeight <= viewH;
    if (placement === "top" && !fitsAbove && fitsBelow) return "bottom";
    if (placement === "bottom" && !fitsBelow && fitsAbove) return "top";
    return placement;
  }

  /**
   * Pure function. Computes the fixed top-left pixel position of the tooltip so
   * it is horizontally centered on the reference box and offset to the chosen
   * side, clamped to stay within the viewport (with a small margin).
   *
   * Works uniformly for both anchoring modes: pass a real element rect to center
   * on the element, or a degenerate cursor rect from `pointRect` to center on
   * the pointer (a zero-width box centers the tip on the cursor's X).
   *
   * @param {"top"|"bottom"} side Resolved side to place on.
   * @param {{left:number,right:number,top:number,bottom:number}} rect Reference rect (viewport coords).
   * @param {number} tipW Measured tooltip width in px.
   * @param {number} tipH Measured tooltip height in px.
   * @param {number} gap Offset between anchor and tooltip in px.
   * @param {number} viewW Viewport width in px.
   * @param {number} viewH Viewport height in px.
   * @param {number} margin Min distance kept from each viewport edge in px.
   * @returns {{left: number, top: number}} Fixed-position coordinates.
   *
   * @example
   * // Centered horizontally on a target at x∈[100,140], above it.
   * computePosition("top", { left: 100, right: 140, top: 300, bottom: 320 }, 40, 20, 6, 1000, 800, 4)
   * // => { left: 100, top: 274 }
   * @example
   * // Centered on a cursor at (500, 300), placed below it with a 6px gap.
   * computePosition("bottom", pointRect(500, 300), 40, 20, 6, 1000, 800, 4)
   * // => { left: 480, top: 306 }
   */
  export function computePosition(side, rect, tipW, tipH, gap, viewW, viewH, margin) {
    const centerX = rect.left + (rect.right - rect.left) / 2;
    let left = centerX - tipW / 2;
    left = Math.max(margin, Math.min(left, viewW - tipW - margin));
    const top = side === "top" ? rect.top - gap - tipH : rect.bottom + gap;
    return { left, top };
  }
</script>

<script>
  let {
    /** @type {string} Plain-text tooltip content. Ignored if `tip` is given. */
    text = "",
    /** @type {"top"|"bottom"} Preferred side; flips when it would clip. */
    placement = "bottom", // default BELOW the pointer (PowerRP user spec)
    /** @type {number} Hover-time threshold in ms before showing (0 = immediate). */
    delay = 0,
    /** @type {boolean} When true, never show the tooltip. */
    disabled = false,
    /** @type {import('svelte').Snippet} Wrapped target element(s). */
    children,
    /** @type {import('svelte').Snippet=} Optional rich content, overrides `text`. */
    tip = undefined,
  } = $props();

  const GAP = 6; // px between anchor and tooltip; also a CSS var default
  const EDGE_MARGIN = 4; // px kept from viewport edges when clamping

  let anchor = $state(null); // wrapping span (the hover/focus target)
  let tipEl = $state(null); // the floating tooltip element (when shown)
  let shown = $state(false);
  // Resolved side; recomputed by place() before the tip ever renders, so the
  // literal default is never displayed (placement drives the real value).
  let side = $state("top");
  let pos = $state({ left: 0, top: 0 });
  let showTimer = 0;
  // Last known cursor position (viewport coords) while hovering. Null means the
  // tip was triggered by keyboard focus, which has no cursor → anchor to element.
  let cursor = $state(null);

  const hasContent = $derived(!!tip || text.length > 0);

  /**
   * Command. Measures the tooltip and positions it. Mutates side/pos.
   * Anchors to the live cursor point when hovering, or to the wrapped element's
   * bounding rect when triggered by keyboard focus (cursor === null).
   */
  function place() {
    if (!tipEl) return;
    const ref = cursor ? pointRect(cursor.x, cursor.y) : (anchor && anchorRect(anchor));
    if (!ref) return;
    const { offsetWidth: tipW, offsetHeight: tipH } = tipEl;
    side = resolvePlacement(placement, ref, tipH, GAP, window.innerHeight);
    pos = computePosition(side, ref, tipW, tipH, GAP, window.innerWidth, window.innerHeight, EDGE_MARGIN);
  }

  /** Command. Shows the tooltip now (used after any delay elapses). Mutates shown. */
  function reveal() {
    if (disabled || !hasContent) return;
    shown = true;
  }

  /**
   * Command. Starts showing on pointer hover, honoring `delay`. Records the
   * cursor position so the tip anchors near it. Mutates cursor + pending timer.
   */
  function openFromPointer(e) {
    cursor = { x: e.clientX, y: e.clientY };
    open();
  }

  /**
   * Command. Starts showing on keyboard focus. Clears any cursor so the tip
   * anchors to the wrapped element's rect instead. Mutates cursor + timer.
   */
  function openFromFocus() {
    cursor = null;
    open();
  }

  /** Command. Shared show path; honors `delay`. Mutates a pending timer. */
  function open() {
    if (disabled || !hasContent || shown) return;
    clearTimeout(showTimer);
    if (delay > 0) showTimer = setTimeout(reveal, delay);
    else reveal();
  }

  /**
   * Command. STILL-MOUSE rule (user spec): pointer motion hides the tip and
   * restarts the stillness timer — the tip (re)appears only once the pointer
   * has been still for `delay` ms (next tick when delay=0). Mutates
   * cursor/shown/timer.
   */
  function track(e) {
    if (!cursor) return; // focus-anchored tip: ignore stray pointermove
    cursor = { x: e.clientX, y: e.clientY };
    shown = false;
    clearTimeout(showTimer);
    showTimer = setTimeout(reveal, delay);
  }

  /** Command. Hides the tooltip and cancels any pending show. Mutates shown/timer. */
  function close() {
    clearTimeout(showTimer);
    shown = false;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  // Reposition once the tooltip element has mounted and been measured.
  $effect(() => {
    if (shown && tipEl) place();
  });

  // While shown, keep the tooltip anchored through scroll/resize. (Cursor-mode
  // tips also update on pointermove via track(); this covers the element path
  // and any layout shifts under the cursor.)
  $effect(() => {
    if (!shown) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- The anchor is a passive display:contents sensor around the consumer's own
     control (button/link), not an interactive widget itself; it needs no role.
     Focus is captured via focusin/focusout which bubble from the real control. -->
<span
  class="tt-anchor"
  bind:this={anchor}
  onpointerenter={openFromPointer}
  onpointermove={track}
  onpointerleave={close}
  onpointerdown={close}
  onfocusin={openFromFocus}
  onfocusout={close}
>
  {@render children()}
</span>

{#if shown}
  <div
    class="tt-tip tt-{side}"
    role="tooltip"
    bind:this={tipEl}
    style="left: {pos.left}px; top: {pos.top}px;"
  >
    {#if tip}{@render tip()}{:else}{text}{/if}
  </div>
{/if}

<style>
  /* The anchor is display:contents so it doesn't alter the wrapped element's
     layout; the whole point is to be an invisible hover/focus sensor. */
  .tt-anchor {
    display: contents;
  }

  .tt-tip {
    /* -- Themeable custom properties: chain to ambient tokens, fall back to
       standalone literals so the tooltip looks right with no host theme. -- */
    --tt-bg: var(--control-bg, rgba(0, 0, 0, 0.9));
    --tt-fg: var(--fg, #f0f0f0);
    --tt-border: var(--border, rgba(255, 255, 255, 0.15));
    --tt-radius: 2px; /* square-ish; rounding reads as sloppy */
    --tt-pad: 4px 8px;
    --tt-font-size: 0.75rem;
    --tt-gap: 6px;
    --tt-max-width: 240px;

    position: fixed;
    z-index: 2147483647; /* above everything; tooltips are top-most UI */
    max-width: var(--tt-max-width);
    padding: var(--tt-pad);
    background: var(--tt-bg);
    color: var(--tt-fg);
    border: 1px solid var(--tt-border);
    border-radius: var(--tt-radius);
    font-size: var(--tt-font-size);
    line-height: 1.35;
    white-space: normal;
    pointer-events: none; /* never intercept; a tooltip is passive */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    /* No transition on position — snapping is correct for an immediate tip. */
  }
</style>
