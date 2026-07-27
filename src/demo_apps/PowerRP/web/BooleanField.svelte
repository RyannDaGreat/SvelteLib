<!--
  BooleanField — a standard boolean row control (toggle), the boolean sibling of
  NumericField. Presentation is a single square toggle button at the standardized
  control size; the ON/OFF state shows via the ICON (never a background fill —
  the toggle-buttons ruling), and the label of each state comes from the row's
  optional on/off icon + tooltip text.

  THE ONE on/off control. Every on/off property in the app reaches it through the
  single `kind: "boolean"` branch of the Inspector's field dispatcher — that is
  the ONLY spelling (core/properties.js ROW_KINDS; the V1 "checkbox" name is
  retired, see RETIRED_ROW_KINDS). There is deliberately no native
  <input type="checkbox"> anywhere in the editor: a native checkbox cannot honour
  the toggle-buttons ruling (no opaque background when active) and would read as
  a second, competing affordance for the same concept.

  It exists so a boolean property gets the SAME row treatment as every other
  property (manifest Round 12: "visibility should be a property like all the
  others… a toggleable boolean… it needs to have key frames on it, just like all
  the other properties"). The Inspector wraps it with the shared row grid and the
  ‹ ◆ › keyframe controls, exactly as it wraps NumericField — so a boolean row is
  keyframeable like any other.

  Live preview: click previews via app.setPreview (viewport re-renders in real
  time, manifest rule) then commits in the same gesture — a boolean has no
  intermediate drag state, so preview+commit are one atomic flip (one undo unit).

  Props:
    app       — the app controller (setPreview/commitPreview).
    path      — full state path, e.g. ["items", id, "active"].
    label     — accessible label / tooltip base.
    value     — the current boolean (already coerced by the caller).
    onIcon    — iconify id shown when true  (default a generic check).
    offIcon   — iconify id shown when false (default a generic blank check).
    onText    — tooltip when true  (what a click will DO: turn it off).
    offText   — tooltip when false (what a click will DO: turn it on).
    disabled  — grays the control and blocks interaction (not-yet-created rows).
  Styling lives in app.css (.boolfield; app convention: no <style>).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let {
    app,
    path,
    label,
    value,
    onIcon = "mdi:check",
    offIcon = "mdi:checkbox-blank-outline",
    onText = null,
    offText = null,
    disabled = false,
  } = $props();

  // Tooltip describes the ACTION a click performs (flip), falling back to a
  // plain state description when the caller gives no explicit action text.
  let tip = $derived(
    value
      ? (onText ?? `${label}: on — click to turn off`)
      : (offText ?? `${label}: off — click to turn on`)
  );

  /** Flips the boolean: preview (live re-render) then commit as one undo unit. */
  function toggle() {
    if (disabled) return;
    app.setPreview([[path, !value]]);
    app.commitPreview();
  }
</script>

<div class="boolfield">
  <Tooltip text={tip}>
    <button
      class="boolbtn"
      class:on={value}
      aria-label={label}
      aria-pressed={value}
      {disabled}
      onclick={toggle}
    >
      <iconify-icon icon={value ? onIcon : offIcon} width="16" height="16"></iconify-icon>
    </button>
  </Tooltip>
</div>
