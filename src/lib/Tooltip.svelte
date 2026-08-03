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

  `anchor="element"` OVERRIDES the pointer case and anchors to the wrapped
  element's rect even while hovering, so the tip sits WHOLLY ABOVE OR WHOLLY
  BELOW the target and can never cover it. Use it when the target is the thing
  being described and occluding it defeats the tip — PowerRP's asset tiles are
  the motivating case (user ruling: "the tooltip should never be intersecting
  [the asset]… fully below or fully above"), since a cursor-anchored tip over a
  thumbnail hides the very image whose name it is reporting. It is OPT-IN because
  the cursor anchor is right for a large target: a panel-wide tip pushed below a
  600px-tall panel would land nowhere near what the pointer is on.

  With `anchor="element"` the tip does NOT follow the cursor (there is nothing to
  follow — the anchor is a fixed box), which also means it does not jitter while
  the pointer moves inside the target.

  Positioned with fixed coordinates AND PORTALLED TO <body> (see the `portal`
  action) — so no scroll container, transform, filter or backdrop-filter between
  the anchor and the root can reinterpret those coordinates or clip the tip.
  Rendering it in place was a real defect, measured, not a hypothetical; the
  action's docblock has the numbers. Placement is "top" or "bottom" (relative to the cursor or element);
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

  Usage (never cover the target — tip goes wholly above/below its rect):
    <Tooltip text="logo.png" anchor="element">
      <div class="tile">…</div>
    </Tooltip>

  CSS custom properties (chain to ambient tokens, with standalone fallbacks):
    --tt-bg        background         (← --control-bg → rgba(0,0,0,0.9))
    --tt-fg        text color         (← --fg → #f0f0f0)
    --tt-border    border color       (← --border → rgba(255,255,255,0.15))
    --tt-radius    corner radius      (2px — square-ish; keep minimal)
    --tt-pad       padding            (4px 8px)
    --tt-font-size font size          (0.75rem)
    --tt-gap       offset from anchor (6px default; set it on any ancestor)
    --tt-max-width max content width  (240px; set it on any ancestor)

  The last two are read off the ANCHOR by the script and applied to the tip
  inline, because the tip renders as a body-level sibling and so inherits nothing
  from the host's subtree — the other properties above are plain CSS on the tip and
  are themed through the ambient --control-bg/--fg/--border tokens instead.
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
   * WHEN NEITHER SIDE FITS it picks the side with MORE ROOM rather than honoring
   * the request. That third case matters only for `anchor="element"`, and there it
   * is the whole point: the tip must stay outside the target's rect ("fully below
   * or fully above" — PowerRP's tile ruling), so when the viewport is too short for
   * either side to be clean, clipping at a viewport edge is the correct sacrifice
   * and covering the target is not. With a degenerate cursor rect the two rooms are
   * equal-ish and this branch is a no-op in practice.
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
   * @example
   * // A tall tip against a short viewport: neither side fits, so the roomier one
   * // wins (below has 700-410=290px, above has 380) — never on top of the target.
   * resolvePlacement("bottom", { top: 380, bottom: 410 }, 400, 6, 700)
   * // => "top"
   */
  export function resolvePlacement(placement, rect, tipHeight, gap, viewH) {
    const roomAbove = rect.top - gap - tipHeight;
    const roomBelow = viewH - (rect.bottom + gap + tipHeight);
    const fitsAbove = roomAbove >= 0;
    const fitsBelow = roomBelow >= 0;
    if (!fitsAbove && !fitsBelow) return roomAbove >= roomBelow ? "top" : "bottom";
    if (placement === "top" && !fitsAbove) return "bottom";
    if (placement === "bottom" && !fitsBelow) return "top";
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

  /**
   * THE REPARENT-TO-BODY ACTION, imported from the kit rather than written here.
   *
   * It was hand-rolled in this file when the portal landed, which made it the
   * FOURTH copy of an action that src/lib/popover.js exists to be the one home
   * of — and tests/popover_reinvention_ban_test.js caught it, correctly. The ban
   * is not about the name `portal`: it detects the SHAPE (an appendChild onto
   * document.body paired with a destroy), so renaming a copy would not evade it,
   * and nothing about this component made it an exception. The kit's version is
   * behaviourally identical, so the import is a straight substitution.
   *
   * WHY A TOOLTIP NEEDS IT AT ALL — the measurement, kept here because it is
   * this component's reason and not the kit's. The tip is `position: fixed`, and a
   * fixed element is positioned against the viewport ONLY while no ancestor
   * establishes a containing block for it. Several ordinary CSS properties do
   * establish one — `transform`, `filter`, `backdrop-filter`, `perspective`,
   * `contain`, `will-change` — and any of them on ANY ancestor silently
   * reinterprets the tip's coordinates as relative to that ancestor's border box.
   * Nothing errors; the tip simply appears somewhere else, and it is also clipped
   * by that ancestor's `overflow`.
   *
   * MEASURED, on PowerRP's floating canvas toolbar (2026-08-02): the tip's inline
   * style read `left: 747.7px; top: 422.5px; max-width: 240px` — the correct
   * viewport coordinates, computed by place() from a correct anchor rect — while
   * its actual getBoundingClientRect was `(1401.7, 801.0) 79.7 x 252.8`. Six
   * hundred px away, and squeezed from 240x75 into a narrow column because the
   * width cap was resolving against the panel instead of the viewport. Setting
   * `backdrop-filter: none` on that one panel — changing nothing else — snapped
   * the tip to exactly (747.7, 422.5) 240x74.75. That is the whole bug, and it is
   * why the user's report was "the hover tooltips [are] in the wrong place".
   *
   * This component's own docblock already CLAIMED the tip "renders as a
   * body-level sibling of the anchor and so inherits nothing from the host's
   * subtree" — the reasoning behind reading --tt-gap and --tt-max-width off the
   * anchor instead of declaring them on the tip. That claim was true about
   * INHERITANCE (the values do come from the anchor) and false about the DOM: the
   * element was rendered in place. The action makes the DOM match the docblock.
   *
   * The consequence a caller might notice: the tip is no longer inside the host's
   * subtree, so a descendant selector rooted at the host will not match it. Style
   * it through the documented --tt-* custom properties, which are read off the
   * anchor precisely so they keep working across the portal.
   *
   * Used below as `use:portal` on the tip's root element:
   *   <div class="tt-tip" use:portal>…</div>
   * mounted inside a blurred panel now satisfies
   *   document.querySelector(".tt-tip").parentElement === document.body
   */
  import { portal } from "./popover.js";

  // AT MOST ONE TOOLTIP OPEN, app-wide. NESTED anchors are why this must be a
  // global invariant rather than per-instance hygiene: a tip-wrapped tile inside
  // a tip-wrapped region receives pointerenter on BOTH anchors (entering the
  // inner never leaves the outer), so both tips stack (user ruling 2026-07-30:
  // "two tooltips at the same time — that's stupid"). Native UIs never show two
  // tips; revealing any tip closes the incumbent. Holds each open instance's
  // own close(), so identity comparison distinguishes self from incumbent.
  let openTipClose = null;
</script>

<script>
  let {
    /** @type {string} Plain-text tooltip content. Ignored if `tip` is given. */
    text = "",
    /** @type {"top"|"bottom"} Preferred side; flips when it would clip. */
    placement = "bottom", // default BELOW the pointer (PowerRP user spec)
    /** @type {"cursor"|"element"} What the tip is positioned against while
     *  HOVERING. "cursor" (default) follows the pointer — the long-standing
     *  behavior. "element" anchors to the wrapped element's rect, so the tip is
     *  wholly outside it and never covers the target (see the docblock). Keyboard
     *  focus always anchors to the element regardless, since there is no cursor. */
    anchor = "cursor",
    /** @type {number} Hover-time threshold in ms before showing (0 = immediate). */
    delay = 0,
    /** @type {boolean} When true, never show the tooltip. */
    disabled = false,
    /** @type {import('svelte').Snippet} Wrapped target element(s). */
    children,
    /** @type {import('svelte').Snippet=} Optional rich content, overrides `text`. */
    tip = undefined,
  } = $props();

  const GAP = 6; // px between anchor and tooltip; the --tt-gap default
  const EDGE_MARGIN = 4; // px kept from viewport edges when clamping
  const MAX_WIDTH = 240; // px cap on tip content width; the --tt-max-width default

  // The wrapping span (the hover/focus target). Named `anchorEl` because `anchor`
  // is now a PROP (which box the tip is placed against) — the element and the
  // policy are two different things and must not share a name.
  let anchorEl = $state(null);
  let tipEl = $state(null); // the floating tooltip element (when shown)
  let shown = $state(false);
  // Resolved side; recomputed by place() before the tip ever renders, so the
  // literal default is never displayed (placement drives the real value).
  let side = $state("top");
  let pos = $state({ left: 0, top: 0 });
  // Content width cap, read off the anchor by place() (the tip inherits nothing —
  // see anchorLength). Seeded with the default so the first measured layout is
  // already correct rather than reflowing from unconstrained.
  let maxWidth = $state(MAX_WIDTH);
  let showTimer = 0;
  // Last known cursor position (viewport coords) while hovering. Null means the
  // tip was triggered by keyboard focus, which has no cursor → anchor to element.
  let cursor = $state(null);

  const hasContent = $derived(!!tip || text.length > 0);

  /**
   * Query. A px custom property read off the ANCHOR, with a fallback. The tip is a
   * body-level sibling and inherits NOTHING from the host's subtree, so every
   * host-settable length has to be fetched from the anchor (which does inherit) and
   * applied to the tip by the script. Non-numeric/absent values fall back.
   *
   * @param {string} prop A custom property name, e.g. "--tt-gap".
   * @param {number} fallback Value used when unset or unparseable.
   * @returns {number} px
   *
   * @example
   * // With `--tt-gap: 10px` set on any ancestor of the anchor:
   * // anchorLength("--tt-gap", 6)  // => 10
   * @example
   * // Unset (or a non-length like "auto") falls back to the default:
   * // anchorLength("--tt-gap", 6)  // => 6
   */
  function anchorLength(prop, fallback) {
    if (!anchorEl) return fallback;
    return parseFloat(getComputedStyle(anchorEl).getPropertyValue(prop)) || fallback;
  }

  /**
   * Command. Measures the tooltip and positions it. Mutates side/pos/maxWidth.
   * Anchors to the live cursor point when hovering, or to the wrapped element's
   * bounding rect when triggered by keyboard focus (cursor === null) OR when
   * `anchor="element"` asked for the tip to stay off the target entirely.
   */
  function place() {
    if (!tipEl) return;
    const useCursor = cursor && anchor !== "element";
    const ref = useCursor ? pointRect(cursor.x, cursor.y) : (anchorEl && anchorRect(anchorEl));
    if (!ref) return;
    // The width cap is applied BEFORE measuring, since it is what determines how the
    // content wraps and therefore both offsetWidth and offsetHeight.
    maxWidth = anchorLength("--tt-max-width", MAX_WIDTH);
    const { offsetWidth: tipW, offsetHeight: tipH } = tipEl;
    const gap = anchorLength("--tt-gap", GAP);
    side = resolvePlacement(placement, ref, tipH, gap, window.innerHeight);
    pos = computePosition(side, ref, tipW, tipH, gap, window.innerWidth, window.innerHeight, EDGE_MARGIN);
  }

  /** Command. Shows the tooltip now (used after any delay elapses). Mutates
   *  shown, and closes any OTHER open tip first (the one-tip invariant above). */
  function reveal() {
    if (disabled || !hasContent) return;
    if (openTipClose && openTipClose !== close) openTipClose();
    openTipClose = close;
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

  /** Command. While hovering, follow the cursor. Mutates cursor and repositions.
   *  A no-op under `anchor="element"`: the tip is placed against a FIXED box, so
   *  there is nothing to follow — and re-measuring per pointermove would put layout
   *  work on the hover path for no visible change. */
  function track(e) {
    if (!cursor || anchor === "element") return; // focus- or element-anchored: ignore stray pointermove
    cursor = { x: e.clientX, y: e.clientY };
    if (shown) place();
  }

  /** Command. Hides the tooltip and cancels any pending show. Mutates shown/timer,
   *  and releases the one-open-tip slot when this instance holds it. */
  function close() {
    clearTimeout(showTimer);
    if (openTipClose === close) openTipClose = null;
    shown = false;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  // Reposition once the tooltip element has mounted and been measured.
  $effect(() => {
    if (shown && tipEl) place();
  });

  // `disabled` GOING TRUE MUST CLOSE AN ALREADY-OPEN TIP, not just refuse the next
  // one. `open()`/`reveal()` already guard on `disabled`, which is enough for a tip
  // that has not shown yet, but a caller can flip `disabled` reactively AFTER
  // `shown` went true — PowerRP's slide navigator does exactly this: a plain hover
  // opens the tip immediately (default delay=0), and only the following pointerdown
  // + move crosses its drag threshold and sets `disabled`. Without this effect the
  // tip that was already open before the drag began would keep tracking the cursor
  // for the rest of the gesture instead of closing with it.
  $effect(() => {
    if (disabled && shown) close();
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
  bind:this={anchorEl}
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
  <!-- PORTALLED TO <body> by the `portal` action below. The tip is
       position:fixed, and a fixed element is positioned against its nearest
       CONTAINING BLOCK — which is the viewport only while no ancestor
       establishes one. Rendered in place, it is at the mercy of every wrapper
       between here and the root. See the portal action for the measurement. -->
  <div
    class="tt-tip tt-{side}"
    role="tooltip"
    bind:this={tipEl}
    use:portal
    style="left: {pos.left}px; top: {pos.top}px; max-width: {maxWidth}px;"
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
    /* --tt-gap and --tt-max-width are deliberately NOT declared here: the tip is
       rendered as a BODY-LEVEL SIBLING of the anchor, so it inherits nothing from
       the host's subtree and a host override of either would never have reached it
       (and declaring one here would shadow it even if it had — the
       --dd-radius/--dn-radius shadowing class of bug). Both are therefore READ OFF
       THE ANCHOR by the script and applied inline: GAP/MAX_WIDTH below are the sole
       defaults. */
    position: fixed;
    z-index: 2147483647; /* above everything; tooltips are top-most UI */
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
