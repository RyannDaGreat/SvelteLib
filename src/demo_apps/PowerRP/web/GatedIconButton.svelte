<script>
  /**
   * A GATED ICON BUTTON THAT IS NOT A COMMAND — the non-registry sibling of
   * web/CommandButton.svelte, for a control whose action is a local function
   * rather than a command-registry entry.
   *
   * ── WHY IT EXISTS SEPARATELY FROM CommandButton ──────────────────────────────
   * CommandButton reads its icon, its label and its disabled REASON from a registry
   * entry. A local control has no entry to read, so it takes those three as props —
   * but it must still honour the same three contracts, because they are properties
   * of a disabled BUTTON, not of the command system:
   *
   *  1. `aria-disabled`, NEVER the native `disabled` attribute. A natively disabled
   *     button is not focusable, so a keyboard user can never reach the tooltip
   *     that says why it is dead. Greying is free either way — app.css already
   *     makes `[aria-disabled="true"]` read exactly as `:disabled`.
   *  2. A GUARDED handler, since the element stays live.
   *  3. AN ICONIFY GLYPH, never a Unicode character. The two SurgeGuiModal jog
   *     arrows this was written for were literal `‹` and `›` in the markup, which
   *     is a typographic quotation mark standing in for an arrow: it inherits the
   *     text font rather than the icon set, so it does not match any other arrow in
   *     the app and its weight and baseline shift with the font stack.
   *
   * AND A REASON IS MANDATORY. `disabledReason` is required whenever the button can
   * be shut, because the failure this whole family guards against is not the grey
   * pixel — it is a dead control that never says why. Those jog arrows had NO
   * tooltip at all, so an author facing two inert chevrons had nothing to read in
   * any modality, pointer or keyboard.
   */
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let {
    /** @type {string} Iconify icon name (e.g. "mdi:chevron-left"). */
    icon,
    /** @type {string} What the button does, as a sentence — its label AND its tip. */
    label,
    /** @type {() => void} The action. Called only when not disabled. */
    onclick,
    /** @type {boolean} Whether the control is gated shut. */
    disabled = false,
    /** @type {string=} WHY it is shut, as a finished sentence. Required whenever
     *  `disabled` can be true — see the header. */
    disabledReason = undefined,
    /** @type {number} Icon size in px (square). */
    size = 16,
    /** @type {string} Classes for the button. Defaults to the app's standard
     *  `.btn-icon`. A surface with its OWN button skin passes that skin instead —
     *  it REPLACES rather than composes, because `.btn-icon` is not a neutral base:
     *  it forces `border: 0` and a fixed square width, which would erase the border
     *  and the `min-width` a bar-mounted control (`.surge-btn`) is drawn with. */
    buttonClass = "btn-icon",
  } = $props();

  /** Query. The button's tooltip: what it does, plus why it cannot right now. */
  let tip = $derived(disabled && disabledReason ? `${label} — ${disabledReason}` : label);
</script>

<Tooltip text={tip}>
  <button
    type="button"
    class={buttonClass}
    aria-label={label}
    aria-disabled={disabled}
    onclick={() => { if (!disabled) onclick(); }}
  >
    <iconify-icon {icon} width={size} height={size}></iconify-icon>
  </button>
</Tooltip>
