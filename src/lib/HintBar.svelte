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
-->
<script>
  import "iconify-icon";
  import { keyIcon } from "./keyicons.js";

  let {
    /** @type {[string[], string][]} List of [keys, label] hints. */
    hints = [],
    /** @type {import('svelte').Snippet} Optional right-aligned content (e.g. a toggle). */
    trailing = undefined,
  } = $props();

  // Mouse tokens → icons; anything else renders as a key chip.
  const MOUSE_ICONS = {
    mouse_left: "mdi:mouse-left-click-outline",
    mouse_right: "mdi:mouse-right-click-outline",
    mouse_middle: "mdi:mouse",
    mouse_scroll: "mdi:mouse-scroll-wheel",
    mouse: "mdi:mouse-outline",
  };

  function isMouse(token) {
    return token in MOUSE_ICONS;
  }
</script>

<div class="hintbar">
  {#each hints as [keys, label]}
    <span class="hint">
      <span class="keys">
        {#each keys as token, i}
          {#if i > 0}<span class="plus">+</span>{/if}
          {#if isMouse(token)}
            <iconify-icon class="mouse" icon={MOUSE_ICONS[token]} width="16" height="16"></iconify-icon>
          {:else if keyIcon(token)}
            <kbd><iconify-icon icon={keyIcon(token)} width="11" height="11"></iconify-icon></kbd>
          {:else}
            <kbd>{token}</kbd>
          {/if}
        {/each}
      </span>
      <span class="label">{label}</span>
    </span>
  {/each}
  {#if trailing}
    <span class="trailing">{@render trailing()}</span>
  {/if}
</div>

<style>
  .hintbar {
    /* -- Themeable custom properties -- */
    --hint-gap: 16px;
    /* Default to the host's theme tokens so the bar follows light/dark; the
       literals are the standalone fallback. */
    --hint-bg: var(--control-bg, rgba(0, 0, 0, 0.4));
    --hint-fg: var(--fg-dim, #aaa);
    --hint-key-fg: var(--fg, #e0e0e0);
    --hint-font-size: 0.72rem;
    --hint-pad: 4px 12px;

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--hint-gap);
    padding: var(--hint-pad);
    background: var(--hint-bg);
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    font-size: var(--hint-font-size);
    color: var(--hint-fg);
    user-select: none;
    white-space: nowrap;
    overflow-x: auto;
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
  kbd {
    font-family: inherit;
    font-size: 0.92em;
    line-height: 1;
    /* EXACTLY one chip height whether the content is a letter or a key-glyph
       icon (letters and icons box differently — fixed dims equalize them). */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    height: var(--hint-key-h, 18px);
    min-width: var(--hint-key-h, 18px);
    padding: 0 5px;
    border: 1px solid currentColor;
    border-radius: 4px;
  }
  .plus {
    opacity: 0.5;
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
</style>
