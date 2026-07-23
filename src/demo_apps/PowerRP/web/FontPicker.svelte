<!--
  FontPicker — the SELF-RENDERING font dropdown (manifest #26): every option's
  name is drawn IN ITS OWN TYPEFACE (the actual loaded @font-face, via
  fonts.js cssFamilyFor), and hovering an option shows a LARGER preview panel
  beside the menu. The trigger shows the current font's name in its own face.

  Why bespoke (not the SvelteLib Dropdown): the Dropdown's menu is width-locked
  to the trigger and `overflow:hidden`, which clips the floating hover preview.
  A font chooser needs the preview to breathe, so this owns its small menu +
  keyboard + outside-click, and delegates ONLY the family resolution to fonts.js.

  Includes uploaded FONT ASSETS automatically: `options` comes from
  fontOptions() (committed + dynamic), and cssFamilyFor resolves an uploaded
  family the same way — an uploaded font previews in its own face too.

  No <style> block (web/ app convention): classes live in app.css (.fontpicker*
  via --a-* tokens). iconify for the caret.
-->
<script>
  import "iconify-icon";
  import { cssFamilyFor } from "../render_gpu/fonts.js";

  // options: [{value, label}] (fontOptions()); value: current font id; onchange(id).
  let { options = [], value = "system", onchange = () => {} } = $props();

  let open = $state(false);
  let activeIndex = $state(-1); // keyboard/hover focus → also drives the preview
  let rootEl;

  let currentLabel = $derived(options.find((o) => o.value === value)?.label ?? value);
  // The option under the keyboard/hover focus — its font fills the preview panel.
  let previewOption = $derived(activeIndex >= 0 ? options[activeIndex] : options.find((o) => o.value === value));

  /** Pure-ish. The CSS font-family for an option id — the actual loaded face. */
  function faceOf(id) {
    return cssFamilyFor(id);
  }

  function openMenu() {
    open = true;
    activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  }
  function closeMenu() {
    open = false;
    activeIndex = -1;
  }
  function toggle() {
    open ? closeMenu() : openMenu();
  }
  function choose(id) {
    onchange(id);
    closeMenu();
  }
  function move(delta) {
    if (!options.length) return;
    const n = options.length;
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
    else if (e.key === "Enter") { e.preventDefault(); if (activeIndex >= 0) choose(options[activeIndex].value); }
  }

  // Outside-click close. Mousedown (not click) so it fires before a blur race,
  // and preventDefault is NOT used here — the toolbar's own keepFocus handles
  // that for the surrounding chrome.
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
      <ul class="fp-menu" role="listbox">
        {#each options as o, i (o.value)}
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
        {/each}
      </ul>

      {#if previewOption}
        <!-- LARGER preview of the focused font (manifest #26 "a larger PREVIEW
             on hover") — the name + a sample line, both in that font's own face. -->
        <div class="fp-preview" aria-hidden="true">
          <div class="fp-preview-name" style:font-family={faceOf(previewOption.value)}>{previewOption.label}</div>
          <div class="fp-preview-sample" style:font-family={faceOf(previewOption.value)}>AaBbCc 0123</div>
          <div class="fp-preview-pangram" style:font-family={faceOf(previewOption.value)}>The quick brown fox jumps over the lazy dog</div>
        </div>
      {/if}
    </div>
  {/if}
</div>
