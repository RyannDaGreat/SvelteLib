<!--
  GalleryPopup — the Inspector row's gutter GALLERY BUTTON (user ask, verbatim:
  "The same UI that pops up when I double-click the Iconify widget (Search All
  of Iconify) could pop up [from the row] with a gallery icon on the far left
  where an eyedropper would have been. A gallery pops up below that we can
  scroll through and search through."). Consumes the SAME {label, grid, search}
  spec CanvasToolbar.svelte renders for the canvas double-click popup — one
  spec, two anchors — but this one is NOT inside CanvasView's PanZoom subtree
  (the Inspector panel is a different DOM region entirely, with its own scroll),
  so it cannot reuse FloatingCanvasPanel; it is a fixed-position portal anchored
  to the gutter button, following the Dropdown.svelte precedent below.

  ── PRECEDENT THIS IS BUILT FROM (not invented fresh) ─────────────────────────
    - The {grid, search} SPEC and its search-debounce/preview/commit mechanics:
      web/CanvasToolbar.svelte — reused verbatim as the tile-grid/search core.
    - PORTAL + fixed positioning to escape the Inspector's own scroll/overflow:
      src/lib/Modal.svelte's `portal` action (reparents to document.body).
    - FOLLOW THE ANCHOR ON OUTSIDE SCROLL rather than closing: src/lib/
      Dropdown.svelte's handleWindowScroll — closing on the Inspector's own
      panel-body scroll (a real, frequent gesture here, not a rare edge case)
      would tear the popup down on every scroll instead of tracking the button.
    - The GUTTER AFFORDANCE ITSELF (icon button left of the row label, only on
      hover): web/lightPositionPin.js's `pinLight` aspect + Inspector.svelte's
      row-label-chrome — `gallery` is the same shape, see plugins/iconify.js.
    - RESIZE PERSISTENCE: web/settings.js's browserNumberSetting — a VIEWER
      preference (the popup's chosen size), never document state, exactly like
      the label-divider fraction and the panel visibility flags.

  ── RESIZE (user ask) ─────────────────────────────────────────────────────────
  "resizable so I can click and drag the corners... nobody would know unless
  the UI highlights the edge or has a grabbable-looking triangle on the
  corners. If anybody resizes, the widget binds to that size and doesn't
  change — rely on scrolling. When you resize it should attempt to fill to
  that size." Two corner grips (bottom-left, bottom-right — the top edge tracks
  the anchor and must not move under the pointer). Dragging either writes BOTH
  browserNumberSettings (width/height) via persist(), which is why one drag
  disables auto-sizing FOREVER (userSized below) rather than just for this
  session: the settings are already durable, so "stops auto-sizing" falls out
  of "there is now always a stored value" with no separate flag needed.
  "attempt to fill to that size" = the popup's flex box requests the stored
  width/height but is still clamped to the viewport (never spills off-screen)
  and to a MIN_SIZE floor (a resize to zero would leave no way to grab it
  again) — ",attempt" honoured, hard failure (an unusable 0x0 popup) refused.

  ── PAGINATION (user ask) ────────────────────────────────────────────────────
  "at least 100 results... but we don't want to crash it, so pagination."
  MEASURED against the real API (plugins/iconify.js's SEARCH_LIMIT docblock):
  Iconify's /search has NO server-side offset/paging — one ranked list capped
  at `limit` (a hard ceiling of 999). So the search fetch itself is unchanged
  (one round trip, capped at SEARCH_LIMIT=100); PAGINATION HERE IS CLIENT-SIDE
  WINDOWING of that one already-fetched array: `revealed` starts at PAGE_SIZE
  tiles and grows by PAGE_SIZE when the grid is scrolled near its own bottom,
  so a 100-tile result never lays out/paints more than PAGE_SIZE new tiles in
  one frame. This is reveal-windowing of a fixed array, not repeated network
  pagination — there is only ever the one fetch per query.

  Props:
    spec        — {label, grid: {property, value, cells, cols, labelKind},
                   search: {placeholder, run}} — see plugins/iconify.js
                   iconifyGallerySpec / CanvasToolbar's docblock for the shape.
    anchorEl    — the gutter button to pop up below (getBoundingClientRect
                  drives placement; see positionPopup).
    open        — bindable; false unmounts (no state survives a close/reopen —
                  a fresh open reruns the empty-query fill, same as the canvas
                  popup double-click precedent).
    onpick(value) — called once, with the picked cell's value, on commit. The
                  caller (Inspector.svelte) owns the actual document write
                  (setPreview+commitPreview), exactly like AssetField's
                  oncommit — this component never touches document state.
-->
<script module>
  import { browserNumberSetting } from "./settings.js";

  /** The popup's DEFAULT content box, before any user resize — a bit taller
   * than CanvasToolbar's grid cap (--a-canvas-toolbar-max-h) since this surface
   * also owns the search input and has no sibling toolbar rows competing for
   * vertical space. */
  const DEFAULT_WIDTH = 320;
  const DEFAULT_HEIGHT = 360;

  /** The floor a drag may not cross — below this the corner grips themselves
   * would no longer fit inside the popup, leaving no way to grow it back. */
  const MIN_WIDTH = 220;
  const MIN_HEIGHT = 180;

  /** Gap kept between the popup and the viewport edge (the Dropdown.svelte
   * VIEWPORT_MARGIN precedent, same value, same purpose — a hairline so the
   * "never clipped" invariant has slack for sub-pixel rounding). */
  const VIEWPORT_MARGIN = 6;

  /** How many result tiles are visible before the FIRST reveal grows the
   * window — plugins/iconify.js's PAGE_SIZE, imported by the caller and passed
   * through `spec`less here; kept local so this file has no import cycle back
   * to the plugin (a gallery spec may come from ANY plugin, not just iconify). */
  const DEFAULT_PAGE_SIZE = 24;

  /** localStorage keys for the persisted popup size — ONE popup type in the
   * app today (the icon gallery), so one pair of keys; a second gallery-aspect
   * consumer would size independently under its own keys if the shared size
   * ever proved wrong for it (not assumed here — no evidence yet either way). */
  const WIDTH_SETTING = browserNumberSetting("powerrp.galleryPopup.width", DEFAULT_WIDTH, MIN_WIDTH, 900);
  const HEIGHT_SETTING = browserNumberSetting("powerrp.galleryPopup.height", DEFAULT_HEIGHT, MIN_HEIGHT, 900);

  /**
   * Pure function. The popup's fixed-position CSS box for one anchor rect,
   * clamped so it never spills past the viewport: below the anchor by default,
   * flipped above when there is no room below and above has more; horizontally
   * clamped to keep its right edge on-screen.
   *
   * @param {{left:number, right:number, top:number, bottom:number}} anchorRect
   * @param {number} width - requested popup width
   * @param {number} height - requested popup height
   * @param {number} viewportW
   * @param {number} viewportH
   * @returns {{left:number, top:number}}
   *
   * @example popupPosition({left:100, right:120, top:50, bottom:70}, 320, 360, 1200, 800)
   * // {left: 100, top: 70} — plain case: below-left of the anchor, everything fits
   * @example popupPosition({left:1000, right:1020, top:50, bottom:70}, 320, 360, 1200, 800)
   * // {left: 874, top: 70} — right edge clamped to viewportW - VIEWPORT_MARGIN
   * @example popupPosition({left:100, right:120, top:750, bottom:770}, 320, 360, 1200, 800)
   * // {left: 100, top: 384} — no room below (800-770=30 < 360); flips above the anchor
   * @example popupPosition({left:100, right:120, top:700, bottom:720}, 320, 500, 1200, 800)
   * // {left: 100, top: 294} — NEITHER side has 500px (below: 80, above: 700); still
   * // clamped so the bottom edge (top + height) never exceeds the viewport, rather
   * // than flipping (which would only trade a bottom overflow for a top one).
   */
  export function popupPosition(anchorRect, width, height, viewportW, viewportH) {
    const spaceBelow = viewportH - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const flipUp = spaceBelow < height && spaceAbove > spaceBelow;
    const rawTop = flipUp
      ? anchorRect.top - height
      : anchorRect.bottom;
    // VERTICAL CLAMP — the horizontal clamp's missing twin. Flipping alone only
    // picks the side with MORE room; when neither side actually holds the full
    // height (a popup taller than the viewport, or an anchor with little room on
    // either side), the un-clamped math still placed a box whose bottom edge ran
    // past viewportH — MEASURED: an anchor near mid-viewport with height=360
    // rendered a popup extending 84px past the bottom, taking its resize grips
    // off-screen where no pointer event could ever reach them (the corner grips'
    // whole reason to exist). Clamping BOTH edges is what "attempt to fill to
    // that size" (user) means for a size the viewport genuinely cannot hold.
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, rawTop),
      Math.max(VIEWPORT_MARGIN, viewportH - height - VIEWPORT_MARGIN),
    );
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, anchorRect.left),
      viewportW - width - VIEWPORT_MARGIN,
    );
    return { left, top };
  }

  /**
   * Pure function. The clamped {width, height} a drag may settle on: never
   * below MIN_WIDTH/MIN_HEIGHT, never larger than the room actually available
   * in each axis.
   *
   * `maxWidth`/`maxHeight` are the CALLER's job to compute, because only the
   * caller knows which edge is fixed: a bottom-RIGHT drag grows rightward from
   * a fixed left edge (room = `viewportW - pos.left - margin`), a bottom-LEFT
   * drag grows LEFTWARD from a fixed right edge (room = `rightEdge - margin`,
   * measuring toward x=0, not toward viewportW). A single "distance from one
   * edge" formula baked into this function got that backwards for the second
   * case — MEASURED: a popup anchored near the viewport's right edge
   * (left=1114 of a 1440 window, popup width 320) refused to grow AT ALL via
   * its bottom-left grip, because the old formula measured room to the RIGHT
   * of the popup's right edge (≈0) instead of room to the LEFT of it (≈1100px,
   * the actually-available space the drag was moving into). Splitting "which
   * edge is fixed" out to the caller (see GalleryPopup.svelte's beginResize)
   * is what makes this function correct for both grips without a direction
   * flag baked into its own signature.
   *
   * @param {number} width - requested width
   * @param {number} height - requested height
   * @param {number} maxWidth - room available in the width axis (caller-computed)
   * @param {number} maxHeight - room available in the height axis (caller-computed)
   * @returns {{width: number, height: number}}
   *
   * @example clampPopupSize(500, 400, 1094, 694)
   * // {width: 500, height: 400} — plenty of room, nothing clamped
   * @example clampPopupSize(50, 50, 1094, 694)
   * // {width: 220, height: 180} — floored at MIN_WIDTH/MIN_HEIGHT
   * @example clampPopupSize(5000, 5000, 1094, 694)
   * // {width: 1094, height: 694} — capped at the room available
   */
  export function clampPopupSize(width, height, maxWidth, maxHeight) {
    return {
      width: Math.min(Math.max(MIN_WIDTH, width), Math.max(MIN_WIDTH, maxWidth)),
      height: Math.min(Math.max(MIN_HEIGHT, height), Math.max(MIN_HEIGHT, maxHeight)),
    };
  }

  /**
   * Pure function. The next reveal-window size for incremental rendering: grows
   * by `pageSize` but never past `total` — the client-side "pagination" over one
   * already-fetched result array (see the file docblock's PAGINATION section).
   *
   * @param {number} revealed - tiles currently shown
   * @param {number} total - tiles available
   * @param {number} pageSize
   * @returns {number}
   *
   * @example nextRevealCount(24, 100, 24) // 48
   * @example nextRevealCount(96, 100, 24) // 100 — capped at total, not 120
   * @example nextRevealCount(100, 100, 24) // 100 — already fully revealed
   */
  export function nextRevealCount(revealed, total, pageSize) {
    return Math.min(total, revealed + pageSize);
  }

  /**
   * Query. Is a scrollable element's bottom within `thresholdPx` of view? The
   * grid's scroll-near-bottom pagination trigger.
   *
   * @param {{scrollTop: number, scrollHeight: number, clientHeight: number}} el
   * @param {number} thresholdPx
   * @returns {boolean}
   *
   * @example nearScrollBottom({scrollTop: 0, scrollHeight: 1000, clientHeight: 300}, 80) // false
   * @example nearScrollBottom({scrollTop: 650, scrollHeight: 1000, clientHeight: 300}, 80) // true
   */
  export function nearScrollBottom(el, thresholdPx) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }
</script>

<script>
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { spec, anchorEl, open = $bindable(false), onpick } = $props();

  /** Command. Svelte action: reparents `node` to document.body — the Modal.svelte
   * portal precedent, for the same reason (escape the Inspector panel's own
   * overflow/scroll clipping, which would otherwise cut the popup at the pane
   * edge exactly like an un-portaled tooltip would). */
  function portal(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  let popupEl = $state(null);
  let pos = $state({ left: 0, top: 0 });
  let size = $state({ width: WIDTH_SETTING.initial, height: HEIGHT_SETTING.initial });

  /** True once ANY drag has committed a size (persist() has run at least once
   * this session OR a prior session already stored one) — "binds to that size
   * and doesn't change" (user). Read from the settings themselves rather than a
   * separate flag: a stored value already IS the record of "the user resized
   * this before", so a second flag would be a second source of truth for the
   * same fact. */
  let userSized = $state(localStorage.getItem(WIDTH_SETTING.key) !== null);

  /** Command. Repositions the popup under the CURRENT anchor rect — called on
   * open, on window resize, and on any outside scroll that moves the anchor
   * (Dropdown.svelte's handleWindowScroll precedent: FOLLOW rather than close,
   * because the Inspector panel-body scrolling is an ordinary, frequent
   * gesture here, not a rare edge case worth tearing the popup down over). */
  function reposition() {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    pos = popupPosition(r, size.width, size.height, window.innerWidth, window.innerHeight);
  }

  $effect(() => {
    if (!open) return;
    reposition();
  });

  function onWindowScroll(e) {
    if (!open) return;
    // The popup's OWN internal scroll (the tile grid) must not reposition the
    // whole popup — only an ancestor of the ANCHOR scrolling does.
    if (popupEl && popupEl.contains(e.target)) return;
    const scroller = e.target === document ? document.documentElement : e.target;
    if (scroller?.contains?.(anchorEl)) reposition();
  }

  function onWindowResize() {
    if (open) reposition();
  }

  function onDocPointerDown(e) {
    if (!open) return;
    if (popupEl && !popupEl.contains(e.target) && e.target !== anchorEl) close();
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function close() {
    open = false;
  }

  // ── RESIZE DRAG (corner grips) ───────────────────────────────────────────
  // Pointer-capture drag, the SplitPane.svelte idiom (pointerdown → move →up)
  // generalized from one axis to two: a corner drag adjusts width AND height
  // together, each independently clamped, and COMMITS (persist()) on every
  // move — not just on release — so "binds to that size" is true even if a
  // drag is abandoned mid-gesture (a stray pointerup outside the window would
  // otherwise strand an uncommitted resize).
  let resizing = $state(false);

  function beginResize(e, corner) {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    const startX = e.clientX, startY = e.clientY;
    const startW = size.width, startH = size.height;
    // THE FIXED EDGE for this corner. "left"/"right" here name the GRIP (the
    // everyday sense — the left-hand or right-hand corner handle), unrelated
    // to CSS `right`: the popup is positioned by `left`/`top` only, per
    // FloatingCanvasPanel's no-transform convention. A right-grip drag grows
    // AWAY from the fixed left edge (room = viewport width minus that edge's
    // x); a left-grip drag grows AWAY from the fixed RIGHT edge, toward x=0
    // (room = that edge's x itself, measuring the OTHER direction) — hence
    // maxWidth is computed differently per corner rather than reusing one
    // "distance to viewportW" formula for both (see clampPopupSize's
    // docblock for the bug that shape caused).
    const sign = corner === "left" ? -1 : 1; // bottom-left grows leftward
    const rightEdge = pos.left + startW; // fixed for a "left" drag
    function onMove(ev) {
      const dw = (ev.clientX - startX) * sign;
      const dh = ev.clientY - startY;
      const maxWidth = corner === "left"
        ? rightEdge - VIEWPORT_MARGIN
        : window.innerWidth - pos.left - VIEWPORT_MARGIN;
      const maxHeight = window.innerHeight - pos.top - VIEWPORT_MARGIN;
      const clamped = clampPopupSize(startW + dw, startH + dh, maxWidth, maxHeight);
      size = clamped;
      // The RIGHT edge must stay put under the pointer for a "left" drag —
      // recomputing pos.left FROM the fixed right edge, never from the anchor
      // (reposition() would snap the popup back under the button mid-drag,
      // silently undoing every leftward pixel just dragged).
      if (corner === "left") pos = { ...pos, left: rightEdge - clamped.width };
      WIDTH_SETTING.persist(clamped.width);
      HEIGHT_SETTING.persist(clamped.height);
      userSized = true;
    }
    function onUp() {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ── SEARCH (mirrors CanvasToolbar.svelte's provider contract exactly) ────
  const SEARCH_DEBOUNCE_MS = 250;
  let query = $state("");
  let allCells = $state(null); // the full fetched result array (already capped at SEARCH_LIMIT)
  let searchStatus = $state("");
  let searchSeq = 0;
  let revealed = $state(DEFAULT_PAGE_SIZE); // the client-side pagination window (see nextRevealCount)

  async function runSearch(q) {
    const seq = ++searchSeq;
    searchStatus = "Searching…";
    try {
      const cells = await spec.search.run(q);
      if (seq !== searchSeq) return;
      allCells = cells;
      revealed = Math.min(DEFAULT_PAGE_SIZE, cells.length);
      searchStatus = cells.length ? "" : "No results";
    } catch (e) {
      if (seq !== searchSeq) return;
      allCells = [];
      revealed = 0;
      searchStatus = e instanceof Error ? e.message : String(e);
      console.error(`PowerRP GalleryPopup: search failed — ${searchStatus}`);
    }
  }

  let firstSearch = true;
  $effect(() => {
    if (!open) return;
    const q = query;
    if (firstSearch) {
      firstSearch = false;
      runSearch(q);
      return;
    }
    const timer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // Reset ALL search state on close so a reopen reruns the empty-query fill —
  // the file docblock's "no state survives a close/reopen" contract.
  $effect(() => {
    if (open) return;
    query = "";
    allCells = null;
    searchStatus = "";
    firstSearch = true;
    revealed = DEFAULT_PAGE_SIZE;
  });

  let visibleCells = $derived((allCells ?? []).slice(0, revealed));

  function onGridScroll(e) {
    if (!allCells || revealed >= allCells.length) return;
    if (nearScrollBottom(e.currentTarget, 120)) {
      revealed = nextRevealCount(revealed, allCells.length, DEFAULT_PAGE_SIZE);
    }
  }

  function onSearchKey(e) {
    if (e.key === "Enter") {
      e.stopPropagation();
      runSearch(e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function pick(cell) {
    onpick?.(cell.value);
    close();
  }
</script>

<svelte:window onscroll={onWindowScroll} onresize={onWindowResize} onpointerdown={onDocPointerDown} />

{#if open}
  <div
    class="gallery-popup"
    class:resizing
    bind:this={popupEl}
    use:portal
    role="dialog"
    aria-label={spec.label ?? "Gallery"}
    tabindex="-1"
    style:left="{pos.left}px"
    style:top="{pos.top}px"
    style:width="{size.width}px"
    style:height="{size.height}px"
    onkeydown={onKeydown}
    data-hint-popover="gallery"
  >
    <div class="gallery-popup-search">
      <input
        type="text"
        class="gallery-popup-search-input"
        placeholder={spec.search?.placeholder ?? "Search…"}
        aria-label={spec.search?.placeholder ?? "Search"}
        spellcheck="false"
        bind:value={query}
        onkeydown={onSearchKey}
      />
      {#if searchStatus}<span class="gallery-popup-status">{searchStatus}</span>{/if}
    </div>
    <div
      class="gallery-popup-grid"
      role="listbox"
      aria-label={spec.label ?? "Gallery"}
      tabindex="-1"
      style={spec.grid?.cols ? `--a-canvas-toolbar-cols: ${spec.grid.cols}` : null}
      onscroll={onGridScroll}
    >
      {#each visibleCells as cell (cell.value)}
        <Tooltip disabled={!cell.label}>
          {#snippet tip()}
            <span class="canvas-toolbar-tile-label" class:identifier={spec.grid?.labelKind === "id"}>{cell.label}</span>
          {/snippet}
          <button
            type="button"
            class="canvas-toolbar-tile"
            class:selected={cell.value === spec.grid?.value}
            role="option"
            aria-selected={cell.value === spec.grid?.value}
            onclick={() => pick(cell)}
          >
            <img class="canvas-toolbar-thumb" src={cell.svg ? `data:image/svg+xml,${encodeURIComponent(cell.svg)}` : ""} alt={cell.label} draggable="false" />
          </button>
        </Tooltip>
      {/each}
    </div>
    <!-- Corner grips: bottom-left/bottom-right ONLY (the top edge tracks the
         anchor and must never move under a drag). Each is a small triangular
         affordance (app.css .gallery-popup-grip, --a-* token-styled) that also
         highlights the popup's edge on hover — "nobody would know unless the UI
         highlights the edge or has a grabbable-looking triangle" (user). -->
    <div
      class="gallery-popup-grip gallery-popup-grip-left"
      role="separator"
      aria-label="Resize gallery"
      aria-orientation="horizontal"
      onpointerdown={(e) => beginResize(e, "left")}
    ></div>
    <div
      class="gallery-popup-grip gallery-popup-grip-right"
      role="separator"
      aria-label="Resize gallery"
      aria-orientation="horizontal"
      onpointerdown={(e) => beginResize(e, "right")}
    ></div>
  </div>
{/if}
