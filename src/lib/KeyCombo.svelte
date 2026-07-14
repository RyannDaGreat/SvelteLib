<!--
  KeyCombo [visual, general] — a key combination rendered as ONE chip.

  Semantics (deliberate): one box = keys pressed SIMULTANEOUSLY. Render a
  CHORD (a vim-style sequence of combos) as multiple KeyCombo chips side by
  side — never split one combo into per-key boxes.

  Tokens: modifier/special keys render as mdi glyph icons (keyicons.js),
  mouse tokens as mouse icons, letters/digits as text.

  Usage:
    <KeyCombo keys={["Cmd", "Shift", "P"]} />

  CSS custom properties:
    --kc-h (chip height, default 18px), --kc-fg (defaults currentColor),
    --kc-font-size, --kc-radius
-->
<script>
  import "iconify-icon";
  import { keyIcon, MOUSE_ICONS, isMouseToken } from "./keyicons.js";

  let { keys = [] } = $props();
</script>

<kbd class="kc">
  {#each keys as token}
    {#if isMouseToken(token)}
      <iconify-icon icon={MOUSE_ICONS[token]} width="13" height="13"></iconify-icon>
    {:else if keyIcon(token)}
      <iconify-icon icon={keyIcon(token)} width="11" height="11"></iconify-icon>
    {:else}
      <span>{token}</span>
    {/if}
  {/each}
</kbd>

<style>
  .kc {
    font-family: inherit;
    font-size: var(--kc-font-size, 0.92em);
    color: var(--kc-fg, currentColor);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    box-sizing: border-box;
    height: var(--kc-h, 18px);
    min-width: var(--kc-h, 18px);
    padding: 0 5px;
    border: 1px solid currentColor;
    border-radius: var(--kc-radius, 4px);
    line-height: 1;
  }
</style>
