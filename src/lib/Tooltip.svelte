<!--
  Tooltip [visual, general] — immediate hover/focus tooltip wrapper.

  Wraps its children and shows a small floating label near them. Unlike native
  `title` tooltips (which wait ~1s), this appears IMMEDIATELY on hover/focus by
  default. An optional `delay` (ms) reintroduces a hover-time threshold: the
  pointer must rest on the target that long before the tip shows.

  Positioned with fixed coordinates measured from the wrapped element's
  getBoundingClientRect — no dependency on scroll containers or transforms.
  Placement is "top" or "bottom"; it flips automatically when the chosen side
  would clip the viewport. Hides on pointerleave, blur, Escape, and pointerdown
  (a click dismisses).

  Usage (immediate — default):
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
    --tt-gap       offset from target (6px)
    --tt-max-width max content width  (240px)
-->
<script module>
  /**
   * Pure function. Chooses the final placement, flipping the requested side
   * when it would clip the viewport but the opposite side fits.
   *
   * @param {"top"|"bottom"} placement Requested side.
   * @param {DOMRect} rect Target rectangle (viewport coords).
   * @param {number} tipHeight Measured tooltip height in px.
   * @param {number} gap Offset between target and tooltip in px.
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
   * it is horizontally centered on the target and offset to the chosen side,
   * clamped to stay within the viewport (with a small margin).
   *
   * @param {"top"|"bottom"} side Resolved side to place on.
   * @param {DOMRect} rect Target rectangle (viewport coords).
   * @param {number} tipW Measured tooltip width in px.
   * @param {number} tipH Measured tooltip height in px.
   * @param {number} gap Offset between target and tooltip in px.
   * @param {number} viewW Viewport width in px.
   * @param {number} viewH Viewport height in px.
   * @param {number} margin Min distance kept from each viewport edge in px.
   * @returns {{left: number, top: number}} Fixed-position coordinates.
   *
   * @example
   * // Centered horizontally on a target at x∈[100,140], above it.
   * computePosition("top", { left: 100, right: 140, top: 300, bottom: 320 }, 40, 20, 6, 1000, 800, 4)
   * // => { left: 100, top: 274 }
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
    placement = "top",
    /** @type {number} Hover-time threshold in ms before showing (0 = immediate). */
    delay = 0,
    /** @type {boolean} When true, never show the tooltip. */
    disabled = false,
    /** @type {import('svelte').Snippet} Wrapped target element(s). */
    children,
    /** @type {import('svelte').Snippet=} Optional rich content, overrides `text`. */
    tip = undefined,
  } = $props();

  const GAP = 6; // px between target and tooltip; also a CSS var default
  const EDGE_MARGIN = 4; // px kept from viewport edges when clamping

  let anchor = $state(null); // wrapping span (the hover/focus target)
  let tipEl = $state(null); // the floating tooltip element (when shown)
  let shown = $state(false);
  // Resolved side; recomputed by place() before the tip ever renders, so the
  // literal default is never displayed (placement drives the real value).
  let side = $state("top");
  let pos = $state({ left: 0, top: 0 });
  let showTimer = 0;

  const hasContent = $derived(!!tip || text.length > 0);

  /** Command. Measures the target + tooltip and positions the tooltip. Mutates side/pos. */
  function place() {
    if (!anchor || !tipEl) return;
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: tipW, offsetHeight: tipH } = tipEl;
    side = resolvePlacement(placement, rect, tipH, GAP, window.innerHeight);
    pos = computePosition(side, rect, tipW, tipH, GAP, window.innerWidth, window.innerHeight, EDGE_MARGIN);
  }

  /** Command. Shows the tooltip now (used after any delay elapses). Mutates shown. */
  function reveal() {
    if (disabled || !hasContent) return;
    shown = true;
  }

  /** Command. Starts showing, honoring `delay`. Mutates a pending timer. */
  function open() {
    if (disabled || !hasContent || shown) return;
    clearTimeout(showTimer);
    if (delay > 0) showTimer = setTimeout(reveal, delay);
    else reveal();
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

  // While shown, keep the tooltip glued to the target through scroll/resize.
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
  onpointerenter={open}
  onpointerleave={close}
  onpointerdown={close}
  onfocusin={open}
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
