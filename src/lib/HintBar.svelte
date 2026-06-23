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

  let {
    /** @type {[string[], string][]} List of [keys, label] hints. */
    hints = [],
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
          {:else}
            <kbd>{token}</kbd>
          {/if}
        {/each}
      </span>
      <span class="label">{label}</span>
    </span>
  {/each}
</div>

<style>
  .hintbar {
    /* -- Themeable custom properties -- */
    --hint-gap: 16px;
    --hint-bg: rgba(0, 0, 0, 0.4);
    --hint-fg: #aaa;
    --hint-key-fg: #e0e0e0;
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
    padding: 2px 5px;
    border: 1px solid currentColor;
    border-radius: 4px;
  }
  .plus {
    opacity: 0.5;
  }
  .label {
    white-space: nowrap;
  }
</style>
