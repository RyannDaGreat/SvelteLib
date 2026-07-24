<!--
  Modal [visual, general] — generic modal dialog: backdrop + centered panel.

  Renders arbitrary content via the `children` snippet inside a dismissible
  overlay. Consumers wrap domain-specific UI around this (an asset-preview
  popup, an open-project picker, …) — this component owns none of that; it
  only owns the dialog mechanics: backdrop, focus, scroll lock, escape/click
  dismissal.

  PORTAL: the panel+backdrop are reparented to `document.body` via the
  `portal` action (below) rather than rendered in place. Studied Tooltip.svelte
  first — it stays in place and wins stacking with a very high z-index alone,
  which works there because a tooltip never needs to escape a clipping/
  overflow:hidden or transformed ancestor (it's a passive label). A modal
  cannot make that assumption: consumers will open it from inside scrollable
  panels, `overflow:hidden` cards, or elements with `transform`/`filter` set
  (which create a new stacking/containing-block context that traps
  `position:fixed` descendants in CSS). A stray ancestor would silently break
  centering or clip the backdrop — exactly the kind of bug that's invisible
  until some future consumer's layout triggers it. Portaling to `document.body`
  sidesteps that entirely, at the one-time cost of a small reparenting action.

  Behavior:
    - `open` (bindable) shows/hides the dialog.
    - Backdrop dims + blocks the page beneath (pointer-events on the backdrop
      only; clicks inside the panel never bubble to it).
    - Escape closes (when `closeOnEscape`); backdrop click closes (when
      `closeOnBackdrop`) — both default true.
    - Focus moves into the panel on open (first focusable, else the panel
      itself) and RETURNS to the previously-focused element on close.
    - Focus is TRAPPED inside the panel while open: Tab/Shift+Tab cycle
      through the panel's focusable elements only.
    - Body scroll is locked while open (`document.body` gets
      `overflow: hidden`); the panel itself scrolls internally if its content
      overflows `--modal-max-height`.
    - `title` (optional) renders a plain header row with a close icon button
      (iconify-icon, repo convention — never a unicode glyph). Omit `title`
      to render only the content snippet (no header row at all).

  Usage:
    <script>
      let open = $state(false);
    </script>
    <button onclick={() => (open = true)}>Open</button>
    <Modal bind:open title="Settings" onclose={() => console.log("closed")}>
      <p>Anything goes here.</p>
    </Modal>

  Usage (no title header, custom size):
    <Modal bind:open>
      <img src="/preview.png" alt="" />
    </Modal>
    <style>
      :global(.modal-panel) { --modal-width: 640px; }
    </style>

  Size (`size` prop): "large" (DEFAULT) fills ~90% of the viewport — the
  app-wide convention that modals are a roomy work surface; "compact" is the old
  fixed 520px dialog column; "auto" shrink-wraps content. Backward-safe: a
  consumer that passes no `size` inherits "large". Per-size CSS below sets the
  --modal-width / --modal-height / --modal-max-height tokens; override any of
  them on `.modal-panel` for a one-off.

  CSS custom properties (chain to ambient tokens, then a standalone fallback):
    --modal-width        panel width               (per size: 90vw/520px/auto)
    --modal-height       panel height              (per size: 90vh/auto/auto)
    --modal-max-height   panel max height          (per size: 90vh/85vh/85vh)
    --modal-bg           panel background           (← --control-bg → #1c1c24)
    --modal-fg           panel text color           (← --fg → #e8e8e8)
    --modal-border       panel border color         (← --border → rgba(255,255,255,0.14))
    --modal-radius       panel corner radius        (0 — square by default)
    --modal-padding      content padding            (16px 20px)
    --modal-shadow       panel drop shadow          (0 8px 32px rgba(0,0,0,0.5))
    --modal-backdrop     backdrop fill              (rgba(0,0,0,0.55))
    --modal-header-gap   gap between title/close    (12px)
    --modal-title-size   title font size            (1rem)
-->
<script module>
  /**
   * Pure function. CSS selector matching the standard set of natively
   * focusable, non-hidden elements — the same list browsers use for Tab
   * order. Shared by the focus-trap (Tab cycling) and the initial-focus
   * search (first element inside the panel).
   *
   * @example FOCUSABLE_SELECTOR // "a[href], button:not([disabled]), ..."
   */
  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "iframe",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  /**
   * Query. Focusable elements inside `root`, in DOM order (document tab
   * order for a single container). Filters out elements hidden via
   * zero-size layout boxes (`offsetParent === null`), which excludes
   * `display:none`/detached nodes but is cheap and side-effect-free.
   *
   * @param {HTMLElement} root Container to search within.
   * @returns {HTMLElement[]}
   *
   * @example
   * // A panel with a close button and two inputs returns all three, in order.
   * // focusablesIn(panelEl) // => [closeButton, input1, input2]
   */
  function focusablesIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null,
    );
  }

  /**
   * Pure function. Given the trap container, the current active element, and
   * Shift key state, returns the element Tab should land on next — wrapping
   * from last to first (or first to last on Shift+Tab). Returns null when
   * there is nothing focusable (caller should fall back to the container).
   *
   * @param {HTMLElement[]} focusables Focusable elements in tab order.
   * @param {Element|null} active Currently focused element.
   * @param {boolean} shift True if Shift is held (reverse direction).
   * @returns {HTMLElement|null} Next element to focus, or null if none exist.
   *
   * @example
   * // Tab from the last item wraps to the first.
   * // nextTrapTarget([a, b, c], c, false) // => a
   * @example
   * // Shift+Tab from the first item wraps to the last.
   * // nextTrapTarget([a, b, c], a, true) // => c
   * @example
   * // No focusables at all: nothing to land on.
   * nextTrapTarget([], null, false) // null
   */
  function nextTrapTarget(focusables, active, shift) {
    if (focusables.length === 0) return null;
    const i = focusables.indexOf(active);
    if (shift) {
      return i <= 0 ? focusables[focusables.length - 1] : focusables[i - 1];
    }
    return i === -1 || i === focusables.length - 1 ? focusables[0] : focusables[i + 1];
  }
</script>

<script>
  import "iconify-icon";

  /**
   * Command. Svelte action: reparents `node` to `document.body` on mount and
   * removes it on destroy, so the modal escapes any ancestor's
   * `overflow:hidden`/`transform`/`filter` stacking context (see the portal
   * note in the file header). Placement in `document.body` is append-only —
   * we don't need to restore a sibling position because the node is created
   * fresh by the `{#if open}` block and destroyed with it.
   *
   * @param {HTMLElement} node Element to move to document.body.
   */
  function portal(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  let {
    /** @type {boolean} Whether the modal is shown. Bindable. */
    open = $bindable(false),
    /** @type {(()=>void)|undefined} Fires whenever the modal closes, for any reason
     *  (Escape, backdrop click, close button). Does not fire on programmatic
     *  `open = false`. */
    onclose = undefined,
    /** @type {string} Optional header title. Omit to render no header row. */
    title = "",
    /** @type {import('svelte').Snippet} Arbitrary panel content. */
    children,
    /** @type {boolean} Clicking the backdrop closes the modal. */
    closeOnBackdrop = true,
    /** @type {boolean} Pressing Escape closes the modal. */
    closeOnEscape = true,
    /** @type {"large"|"compact"|"auto"} Panel sizing. DEFAULT "large" — the
     *  app-wide convention that a modal fills ~90% of the viewport (a roomy work
     *  surface, not a cramped dialog). "compact" is the old fixed 520px column
     *  for a tiny confirm/pick dialog; "auto" shrink-wraps its content. Additive
     *  + backward-safe: a consumer that passes no `size` inherits "large" (90%),
     *  so every existing modal adopts the convention without changing its call. */
    size = "large",
  } = $props();

  let panelEl = $state(null);
  let previouslyFocused = null; // element to restore focus to on close

  /** Command. Closes the modal and notifies the consumer (Escape/backdrop/×
   *  only — never called for a programmatic `open = false`). */
  function requestClose() {
    open = false;
    onclose?.();
  }

  function onBackdropPointerDown(e) {
    if (closeOnBackdrop && e.target === e.currentTarget) requestClose();
  }

  function onKeydown(e) {
    if (!open) return; // svelte:window listens unconditionally; no-op while closed
    if (e.key === "Escape" && closeOnEscape) {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !panelEl) return;
    // Focus trap: keep Tab cycling inside the panel regardless of what else
    // exists on the page (which, post-portal, is everything under body).
    const focusables = focusablesIn(panelEl);
    e.preventDefault();
    (nextTrapTarget(focusables, document.activeElement, e.shiftKey) ?? panelEl).focus();
  }

  // Open/close lifecycle: capture + move focus, lock body scroll, and restore
  // both on close. One effect keyed on `open` keeps entry/exit symmetric.
  $effect(() => {
    if (!open) return;
    previouslyFocused = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Wait a tick so the panel (inside {#if open}) exists to search/focus.
    queueMicrotask(() => {
      if (!panelEl) return;
      const target = focusablesIn(panelEl)[0] ?? panelEl;
      target.focus();
    });
    return () => {
      document.body.style.overflow = prevOverflow;
      // Return focus only if the element is still attached — a consumer that
      // removed it while the modal was open has nothing sane to restore to.
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
      previouslyFocused = null;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="modal-root" use:portal>
    <!-- Presentational click-catcher, not an interactive control: dismissal
         is by mouse (this handler) or keyboard (Escape, wired globally via
         svelte:window above) — the div itself is never a Tab stop. -->
    <div class="modal-backdrop" role="presentation" onpointerdown={onBackdropPointerDown}>
      <div
        class="modal-panel modal-{size}"
        bind:this={panelEl}
        role="dialog"
        aria-modal="true"
        aria-label={title || undefined}
        tabindex="-1"
      >
        {#if title}
          <div class="modal-header">
            <span class="modal-title">{title}</span>
            <button
              type="button"
              class="modal-close"
              aria-label="Close"
              onclick={requestClose}
            >
              <iconify-icon icon="mdi:close" width="1.1em" height="1.1em"></iconify-icon>
            </button>
          </div>
        {/if}
        <div class="modal-body">
          {@render children?.()}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* .modal-root is a zero-footprint wrapper: the portal moves THIS node to
     document.body, so its own box must not participate in body's layout. */
  .modal-root {
    display: contents;
  }

  .modal-backdrop {
    --modal-backdrop: rgba(0, 0, 0, 0.55);

    position: fixed;
    inset: 0;
    z-index: 2147483647; /* above everything, same ceiling as Tooltip */
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--modal-backdrop);
    box-sizing: border-box;
  }

  .modal-panel {
    /* Chain to ambient theme tokens (light/dark aware), then a standalone
       literal fallback — same pattern as DraggableNumber/Tooltip. The three
       sizing tokens (width/height/max-height) are set per SIZE class below;
       these base values are the "compact" defaults so a panel with no size
       class still renders sanely. */
    --modal-width: 520px;
    --modal-height: auto;
    --modal-max-height: 85vh;
    --modal-bg: var(--control-bg, #1c1c24);
    --modal-fg: var(--fg, #e8e8e8);
    --modal-border: var(--border, rgba(255, 255, 255, 0.14));
    /* SQUARE by default — rounded corners read as AI-generated slop (repo
       standing rule). Override --modal-radius to opt into rounding. */
    --modal-radius: 0px;
    --modal-padding: 16px 20px;
    --modal-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    --modal-header-gap: 12px;
    --modal-title-size: 1rem;

    display: flex;
    flex-direction: column;
    width: var(--modal-width);
    height: var(--modal-height);
    max-width: 100%;
    max-height: var(--modal-max-height);
    background: var(--modal-bg);
    color: var(--modal-fg);
    border: 1px solid var(--modal-border);
    border-radius: var(--modal-radius);
    box-shadow: var(--modal-shadow);
    outline: none; /* focus ring not needed on the panel container itself */
  }

  /* SIZE VARIANTS (app-wide convention). The backdrop already pads the viewport
     by 24px and the panel is `max-width:100%`, so 90vw/90vh never overflow. */
  .modal-large {
    /* DEFAULT: fill ~90% of the viewport — the roomy work surface convention. */
    --modal-width: 90vw;
    --modal-height: 90vh;
    --modal-max-height: 90vh;
  }
  .modal-compact {
    /* The old fixed dialog column — for a tiny confirm/pick. */
    --modal-width: 520px;
    --modal-height: auto;
    --modal-max-height: 85vh;
  }
  .modal-auto {
    /* Shrink-wrap the content (e.g. an image preview sized by its own child). */
    --modal-width: auto;
    --modal-height: auto;
    --modal-max-height: 85vh;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--modal-header-gap);
    padding: var(--modal-padding);
    border-bottom: 1px solid var(--modal-border);
    flex: none;
  }

  .modal-title {
    font-size: var(--modal-title-size);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 1.8em;
    height: 1.8em;
    padding: 0;
    background: transparent;
    color: inherit;
    border: 1px solid transparent;
    border-radius: var(--modal-radius);
    cursor: pointer;
  }
  .modal-close:hover {
    background: rgba(128, 128, 128, 0.2);
  }
  .modal-close:focus-visible {
    border-color: var(--modal-border);
    outline: 2px solid color-mix(in srgb, var(--modal-fg) 40%, transparent);
    outline-offset: -2px;
  }

  /* Content scrolls internally if it overflows --modal-max-height; the header
     stays pinned (flex: none above) so only the body area scrolls. */
  .modal-body {
    padding: var(--modal-padding);
    overflow-y: auto;
    min-height: 0; /* allow the flex child to actually shrink and scroll */
  }
</style>
