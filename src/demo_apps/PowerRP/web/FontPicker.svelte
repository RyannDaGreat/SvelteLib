<!--
  FontPicker — the SELF-RENDERING font dropdown (manifest #26): every option's
  name is drawn IN ITS OWN TYPEFACE (the actual loaded @font-face, via
  fonts.js cssFamilyFor), and the focused option shows a LARGER preview panel
  beside the menu — the pangram in REGULAR, BOLD, and UNDERLINED so all three
  styles are visible in the real face. The trigger shows the current font's
  name in its own face.

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
<script>
  import "iconify-icon";
  import { cssFamilyFor } from "../render_gpu/fonts.js";

  // options: [{value, label}] (fontOptions()); value: current font id; onchange(id).
  let { options = [], value = "system", onchange = () => {} } = $props();

  // The sample line shown three ways (regular / bold / underlined) in the preview.
  const PANGRAM = "The quick brown fox jumps over the lazy dog";

  let open = $state(false);
  let query = $state(""); // the search filter (case-insensitive, matched on label)
  let activeIndex = $state(-1); // keyboard/hover focus INTO `filtered` → drives the preview
  let rootEl;
  let searchEl;

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
    <span class="fp-trigger-label" style:font-family={faceOf(value)}>{currentLabel}</span>
    <iconify-icon class="fp-caret" icon="mdi:menu-down" width="16" height="16"></iconify-icon>
  </button>

  {#if open}
    <div class="fp-pop">
      <div class="fp-list">
        <input
          class="fp-search"
          type="text"
          placeholder="Search fonts…"
          aria-label="Search fonts"
          bind:this={searchEl}
          bind:value={query}
        />
        <ul class="fp-menu" role="listbox">
          {#each filtered as o, i (o.value)}
            <li
              class="fp-item"
              class:active={i === activeIndex}
              class:selected={o.value === value}
              role="option"
              aria-selected={o.value === value}
              style:font-family={faceOf(o.value)}
              onclick={() => choose(o.value)}
              onpointerenter={() => (activeIndex = i)}
            >
              {o.label}
            </li>
          {:else}
            <li class="fp-empty" role="presentation">No fonts match</li>
          {/each}
        </ul>
      </div>

      {#if previewOption}
        <!-- LARGER preview of the focused font: name + sample, then the pangram
             in REGULAR, BOLD, and UNDERLINED (manifest #26 "a larger PREVIEW"). -->
        <div class="fp-preview" aria-hidden="true">
          <div class="fp-preview-name" style:font-family={faceOf(previewOption.value)}>{previewOption.label}</div>
          <div class="fp-preview-sample" style:font-family={faceOf(previewOption.value)}>AaBbCc 0123</div>
          <div class="fp-preview-line" style:font-family={faceOf(previewOption.value)}>{PANGRAM}</div>
          <div class="fp-preview-line fp-bold" style:font-family={faceOf(previewOption.value)}>{PANGRAM}</div>
          <div class="fp-preview-line fp-underline" style:font-family={faceOf(previewOption.value)}>{PANGRAM}</div>
        </div>
      {/if}
    </div>
  {/if}
</div>
