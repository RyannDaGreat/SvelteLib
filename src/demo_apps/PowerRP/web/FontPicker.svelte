<!--
  FontPicker — the SELF-RENDERING font dropdown (manifest #26): every option's
  name is always READABLE (drawn in the UI font so you can identify the family)
  next to a small in-face sample that shows the actual loaded @font-face (via
  fonts.js cssFamilyFor). The focused option shows a LARGER preview panel beside
  the menu — a sample line in REGULAR, BOLD, and UNDERLINED so all three styles
  are visible in the real face.

  DISPLAY FACES with a `sample` (fonts.js, e.g. seg7 — its letters are 7-segment
  approximations that read as gibberish, so its name/the pangram are unreadable
  in-face): previews swap in the descriptor's `sample` (fonts.js fontSample).
  Normal fonts have no sample → they preview their name + the pangram unchanged,
  each in its own face. The trigger label reads in the font's own face when that
  face can render its name legibly, else in the readable UI font (so a seg7
  selection is never an unreadable trigger).

  Built for HUNDREDS of families: a SEARCH box filters the list by name
  (case-insensitive) and the option list SCROLLS within a bounded height. Why
  bespoke (not the SvelteLib Dropdown): the Dropdown's menu is width-locked to
  the trigger and overflow:hidden, which clips the floating preview. A font
  chooser needs the preview to breathe, so this owns its menu + search +
  keyboard + outside-click, and delegates ONLY family resolution to fonts.js.

  Includes uploaded FONT ASSETS automatically: `options` comes from fontOptions()
  (committed + dynamic), and cssFamilyFor resolves an uploaded family the same
  way — an uploaded font previews in its own face too.

  No <style> block (web/ app convention): classes live in app.css (.fontpicker,
  .fp-* via --a-* tokens). iconify for the caret.
-->
<script module>
  // Session-persisted list/preview split: the list column width in px once the
  // user has dragged the divider (null → the CSS default token width). MODULE
  // scope so it survives the picker closing + reopening within a session (brief
  // #5 "persist within the session"); a full page reload resets it.
  let sessionListW = null;
</script>

<script>
  import "iconify-icon";
  import { cssFamilyFor, fontSample } from "../render_gpu/fonts.js";

  // options: [{value, label}] (fontOptions()); value: current font id; onchange(id).
  let { options = [], value = "system", onchange = () => {} } = $props();

  // The preview body for a NORMAL font, shown three ways (regular / bold /
  // underlined). A limited-charset face substitutes its own `sample` (below).
  const PANGRAM = "The quick brown fox jumps over the lazy dog";
  // The generic in-face sample beside a NORMAL font's readable row name — a
  // short mixed alnum (kept tight for the narrow list column).
  const FACE_SAMPLE = "AaBb 123";
  // The generic medium sample line in the big preview for a NORMAL font (the
  // wider preview column affords a longer mixed alnum than the row sample).
  const PREVIEW_SAMPLE = "AaBbCc 0123";

  let open = $state(false);
  let query = $state(""); // the search filter (case-insensitive, matched on label)
  let activeIndex = $state(-1); // keyboard/hover focus INTO `filtered` → drives the preview
  // DOM refs (bind:this). $state so effects that read them re-run once bound —
  // the Svelte 5 idiom for refs used in reactive contexts (menuEl in the
  // scrollbar-sync effect; rootEl/searchEl in the focus + outside-click effects).
  let rootEl = $state(null);
  let searchEl = $state(null);
  let listEl = $state(null); // the list COLUMN — the divider drag resizes its width
  let menuEl = $state(null); // the SCROLLABLE option list — wheel + native scroll target

  // The list-column width in px, or null → the CSS default token width. Seeded
  // from the session-persisted split so a reopened picker keeps the last drag.
  let listW = $state(sessionListW);
  // Divider drag: null when idle, else {startX, startW, minW, maxW} (px).
  let dragState = null;
  let dragging = $state(false); // drives the .fp-divider highlight while dragging

  // CUSTOM always-visible scrollbar (native overlay bars auto-hide on macOS —
  // the user's "still no scrollbar" complaint). These mirror the menu's live
  // scroll metrics; the thumb geometry derives from them.
  let scrollTop = $state(0);
  let scrollH = $state(0);
  let clientH = $state(0);
  let thumbDrag = null; // {startY, startTop} while dragging the thumb
  let thumbDragging = $state(false);
  const MIN_THUMB_FRAC = 0.12; // thumb never shorter than 12% of the track (stays grabbable)

  let scrollable = $derived(scrollH > clientH + 1); // is there anything to scroll?
  // Thumb height as a fraction of the track (clamped so it stays grabbable).
  let thumbHeightFrac = $derived(scrollH > 0 ? Math.max(MIN_THUMB_FRAC, clientH / scrollH) : 1);
  // Thumb top as a fraction of the track. Maps scrollTop∈[0, maxScroll] onto the
  // travel room left by the (clamped) thumb height, so the thumb bottom never
  // exceeds the track.
  let thumbTopFrac = $derived.by(() => {
    const maxScroll = scrollH - clientH;
    return maxScroll > 0 ? (scrollTop / maxScroll) * (1 - thumbHeightFrac) : 0;
  });

  let currentLabel = $derived(options.find((o) => o.value === value)?.label ?? value);
  // The visible options after the search filter — the menu AND keyboard nav use THIS.
  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  });
  // The option under the keyboard/hover focus (or the current value when nothing
  // is focused) — its face fills the preview panel.
  let previewOption = $derived(activeIndex >= 0 ? filtered[activeIndex] : options.find((o) => o.value === value));

  /** Pure-ish. The CSS font-family for an option id — the actual loaded face. */
  function faceOf(id) {
    return cssFamilyFor(id);
  }

  /**
   * Pure-ish. The font-family a font's NAME should be drawn in, or null to
   * inherit the readable UI font. A face carrying a `sample` (its name is
   * unreadable in-face, e.g. seg7) → null (readable); a normal font uses its
   * own face so its name reads in-face, unchanged.
   */
  function labelFaceOf(id) {
    return fontSample(id) ? null : faceOf(id);
  }

  /**
   * Pure-ish. The short in-face sample beside a row's readable name — the
   * font's own `sample` when it has one (a display face like seg7 shows its
   * legible sample, not gibberish), else a generic mixed-alnum sample.
   */
  function rowSample(id) {
    return fontSample(id) ?? FACE_SAMPLE;
  }

  /**
   * Pure-ish. The big-preview BODY text for the focused font: its own `sample`
   * when set (a display face previews that legible string), else the alphabetic
   * pangram (normal fonts unchanged).
   */
  function previewText(id) {
    return fontSample(id) ?? PANGRAM;
  }

  /**
   * Pure function. Clamps v into [lo, hi].
   *
   * @example clamp(50, 120, 360) // 120
   * @example clamp(500, 120, 360) // 360
   * @example clamp(200, 120, 360) // 200
   */
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /**
   * Query. Reads a plain-px :root token off the picker root as a number.
   *
   * @param {string} name - The custom-property name, e.g. "--a-fp-list-min-w".
   * @returns {number} The px value (NaN if the token is absent/non-px).
   * @example // tokenPx("--a-fp-list-min-w") // 120
   */
  function tokenPx(name) {
    return parseFloat(getComputedStyle(rootEl).getPropertyValue(name));
  }

  /** Command. Keeps a wheel gesture INSIDE the popover: the option list scrolls,
   *  the canvas behind NEVER pans. The FontPicker mounts inside CanvasView's
   *  PanZoom subtree, whose bubble-phase onwheel pans on any wheel that reaches
   *  it — stopPropagation blocks that. Over the non-scrolling regions (search,
   *  preview) we also preventDefault so nothing behind scroll-chains; over the
   *  list itself we let native scroll run (overscroll-behavior:contain in CSS
   *  stops it chaining out at the list's top/bottom boundary). */
  function onWheel(e) {
    e.stopPropagation();
    if (!menuEl || !menuEl.contains(e.target)) e.preventDefault();
  }

  /** Command. Starts a divider drag: captures the list's current width + the
   *  clamp bounds, marks `dragging`, and installs window pointer listeners
   *  (capture phase, removed on up). Mutates dragState/dragging. */
  function startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    dragState = {
      startX: e.clientX,
      startW: listEl.getBoundingClientRect().width,
      minW: tokenPx("--a-fp-list-min-w"),
      maxW: tokenPx("--a-fp-list-max-w")
    };
    dragging = true;
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", endDrag, true);
  }

  /** Command. Resizes the list column as the pointer moves; writes listW AND the
   *  session-persisted split so a reopened picker keeps the width. */
  function onDragMove(e) {
    if (!dragState) return;
    listW = clamp(dragState.startW + (e.clientX - dragState.startX), dragState.minW, dragState.maxW);
    sessionListW = listW;
  }

  /** Command. Ends the divider drag: clears dragState/dragging + the window
   *  pointer listeners. */
  function endDrag() {
    dragState = null;
    dragging = false;
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", endDrag, true);
  }

  /** Command. Mirrors the menu's live scroll metrics into state so the custom
   *  scrollbar thumb tracks it. Reads menuEl (DOM), writes scroll state. */
  function syncScroll() {
    if (!menuEl) return;
    scrollTop = menuEl.scrollTop;
    scrollH = menuEl.scrollHeight;
    clientH = menuEl.clientHeight;
  }

  /** Command. Starts a scrollbar-thumb drag: captures the pointer origin + the
   *  menu's scrollTop, installs window listeners (removed on up). Mutates
   *  thumbDrag/thumbDragging. */
  function startThumbDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    thumbDrag = { startY: e.clientY, startTop: menuEl.scrollTop };
    thumbDragging = true;
    window.addEventListener("pointermove", onThumbMove, true);
    window.addEventListener("pointerup", endThumbDrag, true);
  }

  /** Command. Scrolls the menu as the thumb is dragged — maps pointer dy through
   *  the track→content ratio (scrollH / trackH). Writes menuEl.scrollTop + resyncs. */
  function onThumbMove(e) {
    if (!thumbDrag || !menuEl) return;
    const trackH = menuEl.clientHeight;
    menuEl.scrollTop = thumbDrag.startTop + (e.clientY - thumbDrag.startY) * (scrollH / trackH);
    syncScroll();
  }

  /** Command. Ends the thumb drag: clears thumbDrag/thumbDragging + window listeners. */
  function endThumbDrag() {
    thumbDrag = null;
    thumbDragging = false;
    window.removeEventListener("pointermove", onThumbMove, true);
    window.removeEventListener("pointerup", endThumbDrag, true);
  }

  function openMenu() {
    open = true;
    activeIndex = Math.max(0, filtered.findIndex((o) => o.value === value));
  }
  function closeMenu() {
    open = false;
    activeIndex = -1;
    query = ""; // start the next open with a fresh, unfiltered list
  }
  function toggle() {
    open ? closeMenu() : openMenu();
  }
  function choose(id) {
    onchange(id);
    closeMenu();
  }
  function move(delta) {
    const n = filtered.length;
    if (!n) return;
    activeIndex = ((activeIndex < 0 ? 0 : activeIndex + delta) % n + n) % n;
  }
  function onKeydown(e) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[activeIndex]) choose(filtered[activeIndex].value); }
  }

  // Focus the search field the moment the menu opens, so typing filters at once.
  $effect(() => {
    if (open && searchEl) searchEl.focus();
  });
  // Keep the focused index in range as the filter narrows (never point past end).
  $effect(() => {
    if (activeIndex >= filtered.length) activeIndex = filtered.length ? 0 : -1;
  });
  // Re-measure the custom scrollbar whenever the menu content or size could
  // change (open, filter, split drag). rAF so the DOM has laid out first.
  $effect(() => {
    filtered; listW; open; // reactive deps (touch → re-run)
    if (open && menuEl) requestAnimationFrame(syncScroll);
  });

  // Outside-click close. Pointerdown (not click) so it fires before a blur race;
  // preventDefault is NOT used here — the toolbar's own keepFocus handles the
  // surrounding chrome.
  $effect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootEl && !rootEl.contains(e.target)) closeMenu(); };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fontpicker" bind:this={rootEl} onkeydown={onKeydown}>
  <button
    type="button"
    class="fp-trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="fp-trigger-label" style:font-family={labelFaceOf(value)}>{currentLabel}</span>
    <iconify-icon class="fp-caret" icon="mdi:menu-down" width="16" height="16"></iconify-icon>
  </button>

  {#if open}
    <!-- onwheel CONSUMES the gesture (see onWheel): scroll the list, never pan
         the canvas this popover floats over. -->
    <div class="fp-pop" onwheel={onWheel}>
      <div class="fp-list" bind:this={listEl} style:width={listW != null ? `${listW}px` : null}>
        <input
          class="fp-search"
          type="text"
          placeholder="Search fonts…"
          aria-label="Search fonts"
          bind:this={searchEl}
          bind:value={query}
        />
        <!-- The scroll region + a CUSTOM always-visible scrollbar (native overlay
             bars auto-hide; this one is painted at all times + draggable). -->
        <div class="fp-menu-wrap">
          <ul class="fp-menu" role="listbox" bind:this={menuEl} onscroll={syncScroll}>
            {#each filtered as o, i (o.value)}
              <li
                class="fp-item"
                class:active={i === activeIndex}
                class:selected={o.value === value}
                role="option"
                aria-selected={o.value === value}
                onclick={() => choose(o.value)}
                onpointerenter={() => (activeIndex = i)}
              >
                <!-- Name ALWAYS readable (UI font); the in-face sample beside it
                     shows the real face — its own `sample` for a limited-charset
                     font (seg7), else a generic mixed-alnum. -->
                <span class="fp-item-name">{o.label}</span>
                <span class="fp-item-sample" style:font-family={faceOf(o.value)} aria-hidden="true">{rowSample(o.value)}</span>
              </li>
            {:else}
              <li class="fp-empty" role="presentation">No fonts match</li>
            {/each}
          </ul>
          {#if scrollable}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="fp-scrolltrack" aria-hidden="true">
              <div
                class="fp-scrollthumb"
                class:dragging={thumbDragging}
                style:height={`${thumbHeightFrac * 100}%`}
                style:top={`${thumbTopFrac * 100}%`}
                onpointerdown={startThumbDrag}
              ></div>
            </div>
          {/if}
        </div>
      </div>

      {#if previewOption}
        <!-- DRAGGABLE separator: drag left/right to repartition the list⟷preview
             split (clamped + session-persisted). A full-height flex child. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="fp-divider"
          class:dragging
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize font list"
          onpointerdown={startDrag}
        ></div>
        <!-- LARGER preview of the focused font: readable name + an in-face
             sample line, then the BODY in REGULAR, BOLD, and UNDERLINED. The
             body is the pangram for a normal font, or the descriptor's `sample`
             for a limited-charset face (seg7) whose pangram would be blank. -->
        <div class="fp-preview" aria-hidden="true">
          <div class="fp-preview-name" style:font-family={labelFaceOf(previewOption.value)}>{previewOption.label}</div>
          <div class="fp-preview-sample" style:font-family={faceOf(previewOption.value)}>{fontSample(previewOption.value) ?? PREVIEW_SAMPLE}</div>
          <div class="fp-preview-line" style:font-family={faceOf(previewOption.value)}>{previewText(previewOption.value)}</div>
          <div class="fp-preview-line fp-bold" style:font-family={faceOf(previewOption.value)}>{previewText(previewOption.value)}</div>
          <div class="fp-preview-line fp-underline" style:font-family={faceOf(previewOption.value)}>{previewText(previewOption.value)}</div>
        </div>
      {/if}
    </div>
  {/if}
</div>
