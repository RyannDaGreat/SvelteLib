<!--
  EquationCodeButton — THE `{}` affordance on an equation row, and the ONE
  expression of it.

  User, 2026-08-06: "You know how some properties have {} displayed on them when
  editing code? Equations should ALWAYS have that option too - a code editing
  modal, with correct autocomplete/highlighting pops up so u can edit the equation
  multiline."

  WHY A COMPONENT AND NOT THREE BUTTONS. "Always" reaches all three surfaces that
  render an equation field — web/NumericField.svelte, web/AngleField.svelte and
  web/Inspector.svelte's generic `equationEntry` — and those three already carry
  three copies of the highlight-pieces wrapper, which Inspector's own docblock flags
  as "one candidate for extraction the day the equation editor becomes its own
  component". Adding a fourth triplicated thing would be the Tower of Babel this
  codebase pays for wherever it appears, so the button is stated once here and
  imported three times.

  IT IS `.code-open`, THE EXISTING CLASS, not a new one. The `{}` on a `code`-kind
  row (Inspector's codeOpen snippet) is the same button doing the same job at the
  same place in the row — the value-END accessory slot — so it takes the same class,
  the same 14px mdi:code-braces glyph and the same hover treatment. A second CSS
  identity for one visual concept is how two buttons drift apart.

  THE TOOLTIP NAMES WHAT OPENS, following codeButtonTip's rule that the `{}` tip
  says what the editor will treat the text as. Here that is always the equation
  language, so the tip carries the one fact a reader cannot see: it is MULTILINE.
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import "iconify-icon";

  let {
    /** @type {object} The app instance (openEquationCode lives there). */
    app,
    /** @type {string} The row's human label, for the tooltip and aria-label. */
    label,
    /** @type {string} DISPLAY-form equation text to seed the editor with. */
    text,
    /** @type {string|null} The item `self.` resolves against in this row's context. */
    selfId = null,
    /** @type {(edited: string) => void} The FIELD's own commit, called on Save.
     *  Not a path write: see app.svelte.js openEquationCode for why the field must
     *  own the display→stored conversion and the units rule. */
    oncommit,
  } = $props();

  const ICON_PX = 14; // matches Inspector's codeOpen — one accessory-glyph size

  /** Pure function. The button's tooltip and accessible name.
   *
   *  @param {string} rowLabel The property's label.
   *  @returns {string}
   *
   *  @example equationCodeTip("Rotation") // "Edit Rotation's equation in the code editor (multiline, with autocomplete)"
   */
  function equationCodeTip(rowLabel) {
    return `Edit ${rowLabel}'s equation in the code editor (multiline, with autocomplete)`;
  }

  const tip = $derived(equationCodeTip(label));
</script>

<Tooltip text={tip}>
  <button
    class="code-open"
    aria-label={tip}
    onclick={() => app.openEquationCode({ text, title: `Edit ${label}`, selfId, commit: oncommit })}
  >
    <iconify-icon icon="mdi:code-braces" width={ICON_PX} height={ICON_PX}></iconify-icon>
  </button>
</Tooltip>
