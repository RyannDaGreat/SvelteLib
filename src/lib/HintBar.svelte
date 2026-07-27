<!--
  HintBar [visual, general] — Blender-style control-help status line.

  Shows the inputs available in the current context. Each hint is a [keys, label]
  pair; keys are tokens rendered left-to-right joined by "+". Keyboard tokens
  become outlined monochrome chips (e.g. [C]); mouse tokens become icons. The
  component owns the icon mapping; the consumer supplies meaning + context and
  themes it via CSS custom properties.

  Usage:
    <HintBar hints={[
      [["mouse_left"], "Add good"],
      [["mouse_right"], "Add bad"],
      [["alt", "mouse_left"], "Erase"],
      [["C"], "Add comment"],
    ]} />

  RESIZABLE, and NEVER self-resizing (two halves of one requirement):

  1. The bar's height is ALWAYS definite — the resting value derived from the row
     metrics (--hint-rest-h), or whatever the user dragged the top grip to. It is
     never the intrinsic height of the content, so a context that contributes
     more hints than the last one CANNOT change the bar's size. Before this, the
     bar was `flex-wrap: wrap` with an auto height: the hint set is context-gated,
     so the row count — and therefore the bar's height — changed on its own every
     time the app's context changed. That was the bug.
  2. OVERFLOW RULE: hints still wrap into rows, but rows past the bar's height are
     CLIPPED — dragging the bar taller is how you reveal them, which is what makes
     the drag worth having. Clipped rather than scrolled: a scroll offset does not
     survive in this bar (measured — the browser returns it to 0 within ~400ms and
     a wheel over it does not move it, with no script touching scrollTop), so
     promising a scrollbar would promise rows the user cannot actually reach.
     Nothing becomes undiscoverable, because the hints and the command palette are
     two surfacings of the ONE registry — the palette still lists everything.

  The top edge is a drag grip that reads as a SplitPane handle (same --sp-handle-*
  tokens, same row-resize cursor), so the bar resizes like every other pane, with
  ONE deliberate difference: its hit pad is one-sided. A SplitPane handle straddles
  a boundary between two panes it owns; this grip's top edge IS the boundary with
  whatever the host puts above the bar, so the pad may only grow DOWNWARD (see
  .hint-grip::before). It cannot BE a SplitPane/SplitView: those divide a
  container they own into fractional panes, whereas this bar is one edge of a
  flex column owned by the host app.

  Props:
    hints     [keys, label] pairs to display.
    trailing  Optional right-aligned snippet (e.g. a toggle).
    height    Bar height in px, bindable; null = the resting height. Same
              bindable-value + onchange shape SplitPane uses for `splits`, so a
              consumer that wants to persist a dragged size has the same hook —
              and, like SplitPane, nothing is persisted unless it does.
    onchange  Called with the final height when a drag ends.

  CSS custom properties:
    --hint-scale     Whole-bar size factor; 1 = the design metrics below (default 0.7)
    --hint-gap, --hint-pad-x, --hint-pad-y, --hint-font-size, --hint-rows
    --hint-bg, --hint-fg, --hint-key-fg, --hint-key-h, --hint-border-w
    --sp-handle-size, --sp-handle-color, --sp-handle-hover, --sp-handle-hit-pad
-->
<script>
  import { onDestroy } from "svelte";
  import KeyCombo from "./KeyCombo.svelte";

  // -- Pure math (general) ----------------------------------------------------

  /**
   * Pure function, general. Height of a bar whose TOP edge is being dragged.
   *
   * Dragging the top edge upward grows the bar, so the pointer displacement is
   * SUBTRACTED. Clamped to [0, maxHeight]. The lower bound that actually
   * governs rendering is the CSS `min-height` (--hint-rest-h); this deliberately
   * does not restate that formula, so 0 here only keeps the value sane.
   *
   * @param {number} startHeight - Bar height in px at mousedown
   * @param {number} dy - Pointer displacement in px since mousedown (positive = down)
   * @param {number} maxHeight - Tallest height that still leaves the siblings room
   * @returns {number} New bar height in px
   *
   * @example resizedHeight(20, -30, 400) // 50   (dragged up 30px → 30px taller)
   * @example resizedHeight(50, 12, 400) // 38    (dragged down 12px → 12px shorter)
   * @example resizedHeight(50, 999, 400) // 0    (clamped at the bottom)
   * @example resizedHeight(50, -999, 400) // 400 (clamped at the top)
   */
  function resizedHeight(startHeight, dy, maxHeight) {
    return Math.max(0, Math.min(maxHeight, startHeight - dy));
  }

  // -- Component --------------------------------------------------------------

  // Pixels the siblings above the bar keep no matter how far it is dragged open,
  // so dragging can never collapse the host's other content to nothing. Same
  // pixel-floor idea (and value) as SplitView's MIN_PANE_PX.
  const MIN_SIBLING_PX = 30;

  let {
    /** @type {[string[], string][]} List of [keys, label] hints. */
    hints = [],
    /** @type {import('svelte').Snippet} Optional right-aligned content (e.g. a toggle). */
    trailing = undefined,
    /** @type {number|null} Bar height in px; null = the CSS resting height. */
    height = $bindable(null),
    /** @type {(height: number) => void} Called after a resize drag ends. */
    onchange = undefined,
  } = $props();

  /** @type {HTMLDivElement|undefined} */
  let shellEl = $state(undefined);
  let resizing = $state(false);

  // Non-reactive drag bookkeeping (SplitView idiom: snapshot at mousedown).
  let startClientY = 0;
  let startHeight = 0;
  let maxHeight = 0;

  /** Command, specific. Begins a grip drag, snapshotting the height to resize from. */
  function beginResize(e) {
    e.preventDefault();
    resizing = true;
    startClientY = e.clientY;
    startHeight = shellEl.getBoundingClientRect().height;
    maxHeight = shellEl.parentElement.clientHeight - MIN_SIBLING_PX;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  /** Command, specific. Resolves the height from the mousedown snapshot on each move. */
  function onMouseMove(e) {
    if (!resizing) return;
    height = resizedHeight(startHeight, e.clientY - startClientY, maxHeight);
  }

  /**
   * Command, specific. Ends the drag, cleans up window listeners, and reconciles
   * `height` with what was actually rendered — CSS `min-height` may have floored
   * it, and a bindable value a consumer might persist must be a height the bar
   * can really take. The final mousemove's state change has already flushed and
   * painted by the time this separate event task runs, so the rect is current.
   */
  function onMouseUp() {
    const wasResizing = resizing;
    resizing = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    if (!wasResizing) return;
    height = shellEl.getBoundingClientRect().height;
    onchange?.(height);
  }

  onDestroy(() => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  });

  // The dragged height arrives in real viewport px; --hint-scale zooms the bar,
  // so it is divided back into the bar's own (design-px) space here — the ONE
  // place the two coordinate spaces meet.
  const heightStyle = $derived(
    height === null ? "" : `--hint-h: calc(${height}px / var(--hint-scale));`,
  );
</script>

<div class="hint-shell" bind:this={shellEl}>
  <!-- Top-edge resize grip. Copied from SplitPane's vertical handle, minus its
       centering margin: there the handle straddles a fractional boundary, here
       the bar's own top edge IS the boundary, so the visible grip stays inside
       the bar and only the ::before hit pad reaches above it. -->
  <div
    class="hint-grip"
    class:hint-grip-active={resizing}
    onmousedown={beginResize}
    role="separator"
    aria-orientation="horizontal"
  ></div>

  <div class="hintbar" style={heightStyle}>
    {#each hints as [keys, label]}
      <span class="hint">
        <!-- ONE chip per combo (one box = pressed together; separate chips are
             reserved for future chords) — the shared KeyCombo component. -->
        <span class="keys">
          <KeyCombo {keys} />
        </span>
        <span class="label">{label}</span>
      </span>
    {/each}
    {#if trailing}
      <span class="trailing">{@render trailing()}</span>
    {/if}
  </div>
</div>

<style>
  /* The shell is unzoomed: it hosts the grip (whose hit area must stay real
     pointer pixels) and keeps the bar from being squeezed by a flex host. */
  .hint-shell {
    position: relative;
    flex: none;
  }

  .hintbar {
    /* -- Themeable custom properties -- */
    /* The metrics below are the bar's 100% design size; --hint-scale trims the
       WHOLE bar — text, chips, gaps, padding, height — to a fraction of it.
       Expressed as `zoom` (a layout scale) rather than per-token calc() because
       KeyCombo's chip internals (its padding, its icon glyph size) are absolute
       px it does not expose as tokens: scaling only the tokens would shrink each
       chip's box while its glyphs stayed put and spilled out of the border. */
    --hint-scale: 0.7;
    --hint-gap: 16px;
    --hint-pad-x: 12px;
    --hint-pad-y: 4px;
    --hint-border-w: 1px;
    /* Rows of hints the bar shows at its resting height. */
    --hint-rows: 1;
    /* Tallest thing in a row is the key chip, and `line-height` below pins the
       labels' line boxes to the same value, so a row is EXACTLY this tall
       whatever the font size — which is what makes --hint-rest-h exact. */
    --hint-row-h: var(--hint-key-h, 18px);
    --hint-rest-h: calc(
      var(--hint-row-h) * var(--hint-rows) + var(--hint-pad-y) * 2 +
        var(--hint-border-w)
    );
    /* Default to the host's theme tokens so the bar follows light/dark; the
       literals are the standalone fallback. */
    --hint-bg: var(--control-bg, rgba(0, 0, 0, 0.4));
    --hint-fg: var(--fg-dim, #aaa);
    --hint-key-fg: var(--fg, #e0e0e0);
    --hint-font-size: 0.72rem;

    zoom: var(--hint-scale);
    box-sizing: border-box;
    /* DEFINITE height, always — the anti-self-resize invariant. --hint-h is the
       user's dragged height when there is one; min-height keeps one row legible
       and is the single floor (the drag math does not restate it). */
    height: var(--hint-h, var(--hint-rest-h));
    min-height: var(--hint-rest-h);

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* Rows stack from the top of a taller bar instead of stretching. */
    align-content: flex-start;
    gap: var(--hint-gap);
    padding: var(--hint-pad-y) var(--hint-pad-x);
    background: var(--hint-bg);
    border-top: var(--hint-border-w) solid var(--border, rgba(255, 255, 255, 0.1));
    font-size: var(--hint-font-size);
    line-height: var(--hint-row-h);
    color: var(--hint-fg);
    user-select: none;
    white-space: nowrap;
    /* Rows past the height are clipped, never scrolled (see the header's
       overflow rule) — drag the bar taller to bring them into view. */
    overflow: hidden;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .keys {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--hint-key-fg);
  }
  /* Chip styling lives in KeyCombo (--kc-*); HintBar forwards its height token. */
  .keys {
    --kc-h: var(--hint-key-h, 18px);
  }
  .label {
    white-space: nowrap;
  }
  /* Right-aligned trailing content (e.g. a theme toggle). */
  .trailing {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
  }

  /* Resize grip — the same affordance as a SplitPane handle. */
  .hint-grip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    height: var(--sp-handle-size, 4px);
    background: var(--sp-handle-color, #444);
    transition: background-color 0.15s;
    cursor: row-resize;
  }
  /* Hit pad, DOWNWARD ONLY — the one place this grip must not copy SplitPane.
     A SplitPane handle straddles a boundary between two panes IT OWNS, so a
     symmetric pad only ever reaches into its own panes. This grip sits on the
     bar's TOP edge, and what lies above it belongs to the HOST — in PowerRP that
     is the canvas. A symmetric `inset: calc(-1 * pad)` therefore claimed a pad-tall
     strip along the BOTTOM OF THE DRAWING SURFACE: a click meant for the canvas
     within a few px of the bar started a bar resize instead. Growing the pad into
     the bar's own body costs nothing (the hints are static text), so the pad is
     bottom-only and the grip's hit area stops exactly at the boundary. */
  .hint-grip::before {
    content: "";
    position: absolute;
    inset: 0 0 calc(-1 * var(--sp-handle-hit-pad, 4px)) 0;
  }
  .hint-grip:hover,
  .hint-grip.hint-grip-active {
    background: var(--sp-handle-hover, #007acc);
  }
</style>
