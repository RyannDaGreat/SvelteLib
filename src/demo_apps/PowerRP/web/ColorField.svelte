<!--
  ColorField — THE color property field (the color sibling of NumericField /
  BooleanField). It fills one row's value cell and gives every color property
  app-wide (fill, stroke, camera background, arrow color, rim color, text
  color, …) ONE control path: a compact swatch + hex readout that, on click,
  INLINE-EXPANDS the SvelteLib ColorPicker directly beneath it.

  WHY inline-expand, not a popover/modal (design decision, W2e):
  - The resting row is minimal (swatch + hex) — matching the round-11 field-
    chrome minimalism ruling: the resting field shows just its value, the full
    control is revealed on demand, exactly like NumericField reveals text entry.
  - A popover would need anchored positioning + outside-click dismiss + a
    portal to escape the Property Panel's scroll/overflow clipping — none of
    which exists as a reusable primitive. Tooltip.svelte is cursor-anchored
    (wrong idiom for a persistent interactive surface); Modal.svelte is a
    portal+backdrop+focus-trap MODAL (the brief bans a modal). Inline expansion
    lives in the panel's own reactive/scroll flow: it can't be clipped or
    mispositioned, and the preview/commit wiring stays local (no portal
    indirection), so Escape and live-preview handling are trivial.
  - The Inspector is already an accordion-of-categories; an inline reveal is the
    established visual language of this panel.

  Live semantics (the house preview/commit contract, same as NumericField):
    picker oninput  → app.setPreview  (viewport re-renders live mid-gesture;
                      the document is UNCHANGED until settle)
    picker onchange → app.commitPreview (ONE undo unit per settled gesture)
    Escape while open → app.cancelPreview() + close (reverts the preview)
  No Enter is ever required (Round-12 inspector ruling): selection applies live.

  EYEDROPPER: the head also carries a small eyedropper button (mdi:eyedropper).
  On click it opens the browser EyeDropper API (Chrome/Edge, secure context
  only) so the user can sample a pixel from ANYWHERE on screen — including
  outside the browser window — and the sampled #rrggbb is committed through the
  SAME commit() path as the picker (one undo unit, keyframes like any picked
  color). Where the API is unavailable (Firefox/Safari, or an insecure
  non-localhost HTTP origin) the button is shown DISABLED with a tooltip saying
  so — never a crash, never a silent no-op. A user-cancelled pick is swallowed.

  Storage format is #rrggbbaa (interpolators tween alpha), but a FULLY OPAQUE
  color is written back as 6-digit #rrggbb — so documents that never touch alpha
  never change shape (the composedHex invariant this field replaces). Legacy
  #rrggbb values load fine (opaque); unparseable stored values show as a "?"
  swatch and the raw text, and open the picker at opaque black (visible +
  fixable, never a silent blacken).

  EQUATION VALUES (`=…`, the universal any-type gate) are NOT unparseable colors:
  a caller that hands this field a RAW property value — the Inspector's grayed
  not-yet-created rows read the creation slide's raw state — can hand it an
  equation, which used to render as the "?" corrupt-value affordance (danger-red
  raw text) beside a swatch that opened the picker at BLACK, i.e. a click away
  from silently replacing the equation with a color. Such a value now renders as
  what it is: the ƒ mark plus the expression, with no swatch, no eyedropper and
  no picker. EDITING an equation is NOT this field's job — the Inspector row owns
  the universal `=` field (Tier 0), and this field is also mounted where an
  equation would NOT be evaluated at all (PaintField renders one per gradient
  STOP, and core keeps array elements opaque to equation detection), so offering
  entry here would author equations that silently never run.

  Props: app, path (full state path, e.g. ["items", id, "fill"]), label,
  value (the raw stored color string), disabled.
  Styling lives in app.css (.colorfield; app convention: no <style>).
-->
<script module>
  // isHexColor is imported from core (the document tween code's canonical test)
  // so what this field accepts is exactly what storage accepts — one source of
  // truth, no drift between the field and the interpolator.
  import { isHexColor } from "../core/interpolators.js";

  /**
   * Pure function. Normalizes any accepted hex to lowercase long form —
   * "#rrggbb" (opaque) or "#rrggbbaa" — doubling "#rgb"/"#rgba" shorthand
   * digits. Returns null for anything unparseable (the field then shows the raw
   * text + a "?" swatch). This is the ONE display-normalization for the field.
   *
   * Examples:
   *     >>> normalizedHex("#7AA2F7")
   *     '#7aa2f7'
   *     >>> normalizedHex("#7aa2f780")
   *     '#7aa2f780'
   *     >>> normalizedHex("#f08")
   *     '#ff0088'
   *     >>> normalizedHex("#f08c")
   *     '#ff0088cc'
   *     >>> normalizedHex("nope")
   *     null
   */
  export function normalizedHex(value) {
    if (!isHexColor(value)) return null;
    let h = value.slice(1).toLowerCase();
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return "#" + h;
  }

  /**
   * Pure function. Is this stored value an `=` EQUATION rather than a color
   * literal? The universal any-type gate is the leading `=` (manifest "THE `=`
   * MARKER"); core's isEquationValue answers the same question but needs the
   * owning plugin + property path, which a display-level field does not have.
   *
   * Examples:
   *     >>> isEquationColor("=#ff0000")
   *     true
   *     >>> isEquationColor("= other.fill")
   *     true
   *     >>> isEquationColor("#ff0000")
   *     false
   *     >>> isEquationColor(null)
   *     false
   */
  export function isEquationColor(value) {
    return typeof value === "string" && /^\s*=/.test(value);
  }

  /**
   * Pure function. The color as the ColorPicker's canonical 8-digit
   * "#rrggbbaa" input — a normalized value's alpha is preserved, a 6-digit
   * value is made opaque (…ff), an unparseable value opens the picker at
   * opaque black. Keeps the picker's cursor position meaningful regardless of
   * stored form.
   *
   * Examples:
   *     >>> toPicker("#7aa2f7")
   *     '#7aa2f7ff'
   *     >>> toPicker("#7aa2f780")
   *     '#7aa2f780'
   *     >>> toPicker("nope")
   *     '#000000ff'
   */
  export function toPicker(value) {
    const n = normalizedHex(value);
    if (!n) return "#000000ff";
    return n.length === 9 ? n : n + "ff";
  }

  /**
   * Pure function. The ColorPicker's 8-digit "#rrggbbaa" output collapsed to
   * the STORED form: fully-opaque colors (alpha byte ff) become 6-digit
   * "#rrggbb" so documents that never use alpha never grow an alpha channel
   * (the composedHex invariant); translucent colors stay 8-digit. A value
   * that is somehow not 8-digit passes through normalized (defensive; the
   * picker always emits 8 digits).
   *
   * Examples:
   *     >>> toStored("#7aa2f7ff")
   *     '#7aa2f7'
   *     >>> toStored("#7aa2f780")
   *     '#7aa2f780'
   *     >>> toStored("#00000000")
   *     '#00000000'
   */
  export function toStored(picked) {
    const n = normalizedHex(picked);
    if (!n) return picked;
    if (n.length === 9 && n.slice(7) === "ff") return n.slice(0, 7);
    return n;
  }
</script>

<script>
  import "iconify-icon";
  import ColorPicker from "../../../lib/ColorPicker.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { fanOutPairs } from "../core/multiselect.js";

  let { app, path, paths = null, label, value, disabled = false } = $props();
  /**
   * THE WRITE TARGETS. Reads stay on the singular `path` (the PRIMARY item — in a
   * multi-selection every selected item agrees on this value, or the row would be
   * showing the MIXED mark instead of this field), while WRITES fan out to all of
   * them. `paths` absent = the single-selection case, byte-identically as before.
   */
  let writePaths = $derived(paths ?? [path]);


  let open = $state(false);

  // Browser EyeDropper API (Chrome/Edge, secure context only) — a STATIC
  // capability, so a plain const suffices (it cannot change mid-session). When
  // false the eyedropper button is shown disabled with an explanatory tooltip.
  const eyedropperSupported = typeof window !== "undefined" && typeof window.EyeDropper === "function";
  const EYEDROPPER_TIP = "Pick a color from anywhere on screen";
  const EYEDROPPER_UNSUPPORTED_TIP = "Needs Chrome or Edge on an HTTPS/localhost page";

  // Display readouts derived from the raw stored value.
  let equation = $derived(isEquationColor(value)); // an `=` expression, not a literal
  let norm = $derived(normalizedHex(value)); // null when unparseable
  let picker = $derived(toPicker(value)); // always #rrggbbaa for the picker
  // The swatch fill (with alpha over the checker) and the hex text shown when
  // collapsed. Unparseable → raw text + a "?" marker (never a silent black).
  let swatchCss = $derived(norm ?? "#00000000");
  let hexText = $derived(norm ?? String(value ?? ""));

  /** Live preview of a picker gesture — viewport re-renders mid-drag; the
   * document stays UNCHANGED until commit (the house contract). Stored in
   * collapsed form so opaque colors never grow an alpha channel. */
  function preview(picked) {
    app.setPreview(fanOutPairs(writePaths, toStored(picked)));
  }
  /** Settle: commit the previewed color as ONE undo unit (picker onchange). */
  function commit(picked) {
    app.setPreview(fanOutPairs(writePaths, toStored(picked)));
    app.commitPreview();
  }

  /**
   * Command. Opens the OS eyedropper and commits the sampled screen color
   * through the field's normal commit() path (so it lands as ONE undo unit and
   * keyframes exactly like a picked color). No-op when the field is disabled or
   * the API is unsupported. A user-cancelled pick (AbortError) is expected
   * control flow and is swallowed; any other failure is re-thrown (no silent
   * failure). Relies on the click's user gesture — invoked only from onclick.
   */
  async function pickFromScreen() {
    if (disabled || !eyedropperSupported) return;
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      commit(sRGBHex);
    } catch (err) {
      if (err && err.name === "AbortError") return; // user dismissed the picker
      throw err;
    }
  }

  function toggleOpen() {
    if (disabled) return;
    open = !open;
  }

  /** Escape while the picker is open reverts the live preview and closes it
   * (no Enter needed anywhere — the ruling). Stops propagation so Escape does
   * not also bubble into Deselect. */
  function onKeydown(e) {
    if (e.key === "Escape" && open) {
      app.cancelPreview();
      open = false;
      e.stopPropagation();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="colorfield" class:disabled data-hint-popover={open ? "menu" : null} onkeydown={onKeydown}>
  <div class="colorfield-head">
    {#if equation}
      <!-- EQUATION-BOUND: the ƒ mark + the expression in the same monospace
           readout a hex uses (an expression reads as code too). No swatch (there
           is no literal to swatch), no eyedropper and no picker — every one of
           them would overwrite the equation with a color. -->
      <Tooltip text={`${label} is an equation — edit it in the row's ƒ field`}>
        <span class="colorfield-hex">
          <iconify-icon icon="mdi:function-variant" width="13" height="13"></iconify-icon>
          {value}
        </span>
      </Tooltip>
    {:else}
      <Tooltip text={open ? `${label} — click to close` : `${label} — click to edit`}>
        <button
          class="colorfield-swatch"
          style:--cf-swatch={swatchCss}
          aria-label={`${label}: ${hexText}${open ? " (editing)" : ""}`}
          aria-expanded={open}
          {disabled}
          onclick={toggleOpen}
        >
          {#if !norm}<span class="colorfield-unknown">?</span>{/if}
        </button>
      </Tooltip>
      <span class="colorfield-hex" class:unknown={!norm}>{hexText}</span>
      <Tooltip text={eyedropperSupported ? EYEDROPPER_TIP : EYEDROPPER_UNSUPPORTED_TIP}>
        <!-- Eyedropper: sample a screen pixel into this field. When unsupported the
             button stays hoverable (native `disabled` would swallow the tooltip that
             explains WHY) but is greyed + aria-disabled; the click handler no-ops.
             Styled inline with ambient/--a-* tokens — this change does not touch
             app.css, mirroring PaintField's inline-token convention. -->
        <button
          type="button"
          class="colorfield-eyedropper"
          aria-label={`${label}: pick color from screen`}
          aria-disabled={!eyedropperSupported}
          {disabled}
          onclick={pickFromScreen}
          style="display:inline-flex; align-items:center; justify-content:center; flex:none;
                 padding:0; background:transparent; border:none; color:var(--fg-dim);
                 cursor:{eyedropperSupported ? 'pointer' : 'not-allowed'};
                 opacity:{eyedropperSupported ? 1 : 0.4};"
        >
          <iconify-icon icon="mdi:eyedropper" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
    {/if}
  </div>
  {#if open && !equation}
    <!-- The full picker, inline. oninput previews live per gesture, onchange
         commits on settle. Its --cp-* props chain to our --a-* tokens in
         app.css so it matches every theme. Never shown for an equation-bound
         value: picking would write a literal over the expression. -->
    <div class="colorfield-picker">
      <ColorPicker value={picker} {label} {disabled} oninput={preview} onchange={commit} />
    </div>
  {/if}
</div>
