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

  Storage format is #rrggbbaa (interpolators tween alpha), but a FULLY OPAQUE
  color is written back as 6-digit #rrggbb — so documents that never touch alpha
  never change shape (the composedHex invariant this field replaces). Legacy
  #rrggbb values load fine (opaque); unparseable stored values show as a "?"
  swatch and the raw text, and open the picker at opaque black (visible +
  fixable, never a silent blacken).

  Props: app, path (full state path, e.g. ["items", id, "fill"]), label,
  value (the raw stored color string), disabled.
  Styling lives in app.css (.colorfield; app convention: no <style>).
-->
<script module>
  /**
   * Pure function. True for the CSS hex forms this field round-trips:
   * "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" (case-insensitive). Mirrors the
   * document tween code's isHexColor so what the field accepts is exactly what
   * storage accepts.
   *
   * Examples:
   *     >>> isHexColor("#7aa2f7")
   *     true
   *     >>> isHexColor("#7aa2f780")
   *     true
   *     >>> isHexColor("#f08")
   *     true
   *     >>> isHexColor("blue")
   *     false
   */
  export function isHexColor(s) {
    return typeof s === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s);
  }

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

  let { app, path, label, value, disabled = false } = $props();

  let open = $state(false);

  // Display readouts derived from the raw stored value.
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
    app.setPreview([[path, toStored(picked)]]);
  }
  /** Settle: commit the previewed color as ONE undo unit (picker onchange). */
  function commit(picked) {
    app.setPreview([[path, toStored(picked)]]);
    app.commitPreview();
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
<div class="colorfield" class:disabled onkeydown={onKeydown}>
  <div class="colorfield-head">
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
  </div>
  {#if open}
    <!-- The full picker, inline. oninput previews live per gesture, onchange
         commits on settle. Its --cp-* props chain to our --a-* tokens in
         app.css so it matches every theme. -->
    <div class="colorfield-picker">
      <ColorPicker value={picker} {label} {disabled} oninput={preview} onchange={commit} />
    </div>
  {/if}
</div>
