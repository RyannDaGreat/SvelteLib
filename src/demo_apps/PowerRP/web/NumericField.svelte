<!--
  NumericField — THE equation-aware numeric field (THE UNIFICATION), shared by
  the Property Panel and the Variables Panel.

  Presentation is decided by the STORED value's type (string = equation):
  - NUMBER: SvelteLib DraggableNumber (scrub + keyboard nudge). Scrubbing an
    equation is impossible by construction — equations render as text, never
    as the scrubber (user rule: no offset-scrubbing invention).
  - EQUATION: monospace text input showing the DISPLAY form (slugs, e.g.
    "circle_top.x + 10"); the stored form uses @itemIds (see
    core/expressions.js for why: renames survive with zero rewrites). A
    leading "=" is tolerated and stripped (spreadsheet affordance).

  ONE text-entry path decides the type SYMMETRICALLY (user ruling, round 10 —
  mode-toggle buttons were rejected): whatever the user types, a pure numeric
  expression ("42", "6*7") commits as a plain NUMBER; anything with
  references commits as an EQUATION. beginTextEntry() opens that path
  pre-filled with the current value.
  CLICK-WITHOUT-DRAG on the number scrubber opens text entry: DraggableNumber
  emits `onedit` on a click that doesn't cross its slop threshold, and we
  DELEGATE to beginTextEntry() (wired below) so the ONE symmetric text path
  lives here — the lib scrubber stays generic, this field owns the
  equation-aware entry. (Drag still scrubs; nothing here changed for that.)

  Display units: `display` (a row option, e.g. "degrees") shows/edits the
  value in a unit different from how core STORES it — rotation edits in
  degrees though core stores radians (round-10 ruling). DISPLAY ONLY, never
  migrates storage; conversion happens at this field boundary via
  ./displayUnits.js. It applies to the number scrubber, the numeric text-entry
  commit, and the evaluated badge. A free-form EQUATION's text is authored in
  stored-space references and stored verbatim — only its evaluated BADGE is
  shown in display units; the expression string itself is not unit-converted
  (out of scope: converting arbitrary arithmetic between units is ill-defined).

  Live preview: valid drafts preview via app.setPreview (viewport re-renders
  in real time, manifest rule); Enter/blur commits (one undo unit); Escape
  reverts. Invalid drafts show the invalid affordance and cancel the preview.
  Evaluation errors (cycles, unknown refs) show the error affordance with the
  message from the derivation stage's error map.

  Props: app, path (full state path, e.g. ["items", id, "x"] or
  ["vars", name]), label, min/max (DraggableNumber bounds, in STORED units),
  display (display-unit name, e.g. "degrees"; null = identity).
  Styling lives in app.css (.numfield / .eq-*; app convention: no <style>).
-->
<script>
  import "iconify-icon";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { getPath } from "../core/deltas.js";
  import { displayToStored, storedToDisplay, compiled, evalAst } from "../core/expressions.js";
  import { displayUnit } from "./displayUnits.js";

  let { app, path, label, min = null, max = null, display = null, scrub = null } = $props();

  // Scrub sensitivity (manifest "Number-slider sensitivity"): an explicit
  // per-row `scrub` coefficient wins (transition seconds = 0.1/px); otherwise
  // a BOUNDED row spans its full range across RANGE_DRAG_PX of drag — the fix
  // for opacity flicking 0↔1 (1px used to be a full unit). RANGE_DRAG_PX=100
  // is LINKED to the DraggableNumber demo's canonical 0..1 slider, which uses
  // coefficient 0.01 (= 100px full range). Unbounded rows keep 1/px.
  const RANGE_DRAG_PX = 100;
  let dragCoefficient = $derived(
    scrub != null ? scrub
    : min != null && max != null ? (unit.toDisplay(max) - unit.toDisplay(min)) / RANGE_DRAG_PX
    : 1,
  );

  // Display-unit transform (rotation edits in degrees though core stores
  // radians; identity for every other field). DISPLAY ONLY — never migrates
  // storage. See ./displayUnits.js.
  let unit = $derived(displayUnit(display));

  let stored = $derived(getPath(app.rawState(), path));
  let isEquation = $derived(typeof stored === "string");
  let evaluated = $derived(getPath(app.state(), path));
  let error = $derived(app.exprErrorAt(path));

  // Text entry started FROM number mode (pre-commit) — the field shows the
  // text input before any equation exists in the document.
  let textEntry = $state(false);
  let focused = $state(false);
  let invalid = $state(false);
  let draft = $state("");
  let eqInputEl = $state(null);

  let showText = $derived(isEquation || textEntry);

  // Keep the draft synced to the document while the user is NOT typing —
  // a bind:value-style local buffer avoids caret fights with live preview.
  $effect(() => {
    if (!focused) draft = isEquation ? storedToDisplay(stored, app.rawState()) : "";
  });

  function round3(v) {
    return typeof v === "number" ? Math.round(v * 1000) / 1000 : 0;
  }

  // ── Number mode (DraggableNumber emits DISPLAY-unit numbers) ───────────────
  // DraggableNumber scrubs in the shown unit (degrees for rotation); we convert
  // back to the STORED unit (radians) before writing. Identity for normal rows.

  function previewNumber(shown) {
    app.setPreview([[path, unit.fromDisplay(shown)]]);
  }

  function commitNumber(shown) {
    app.setPreview([[path, unit.fromDisplay(shown)]]);
    app.commitPreview();
  }

  // ── The ONE text-entry path (numbers AND equations) ────────────────────────

  /** Draft → stored-form string (throws on bad syntax/unknown refs). */
  function toStored(text) {
    return displayToStored(text, app.rawState());
  }

  function onEqInput(e) {
    draft = e.target.value;
    try {
      app.setPreview([[path, toStored(draft)]]);
      invalid = false;
    } catch {
      // Invalid draft: affordance only — the specific message would thrash
      // while typing; commit reports loudly if the user insists.
      app.cancelPreview();
      invalid = true;
    }
  }

  /** Commits the draft; WHAT WAS TYPED decides the type (symmetric): a pure
   * numeric expression becomes a plain number, references make an equation. */
  function commitText() {
    let storedForm;
    try {
      storedForm = toStored(draft);
    } catch (e) {
      console.error(`PowerRP: equation not committed: ${e.message}`);
      app.cancelPreview();
      invalid = false;
      textEntry = false;
      draft = isEquation ? storedToDisplay(stored, app.rawState()) : "";
      return;
    }
    const { ast, refs } = compiled(storedForm);
    // A pure numeric expression is entered in DISPLAY units (degrees) and
    // stored in core units (radians); an equation is stored verbatim (its
    // text is authored in stored-space references — unit conversion of
    // free-form expressions is out of scope, see the field header note).
    const value = refs.length === 0 ? unit.fromDisplay(evalAst(ast, () => 0)) : storedForm;
    app.setPreview([[path, value]]);
    app.commitPreview();
    invalid = false;
    textEntry = false;
  }

  function onEqKeydown(e) {
    if (e.key === "Enter") {
      commitText();
      e.target.blur();
    } else if (e.key === "Escape") {
      app.cancelPreview();
      invalid = false;
      textEntry = false;
      draft = isEquation ? storedToDisplay(stored, app.rawState()) : "";
      e.target.blur();
      e.stopPropagation(); // don't let Escape bubble into Deselect
    }
  }

  function onEqBlur() {
    focused = false;
    const current = isEquation ? storedToDisplay(stored, app.rawState()) : null;
    if (invalid || textEntry || draft !== current) commitText();
  }

  /** Opens keyboard text entry pre-filled with the current value — the seam
   * DraggableNumber's click-without-drag plugs into (see header comment).
   * Pre-fill is in DISPLAY units (degrees for rotation) to match what the
   * number scrubber showed. */
  async function beginTextEntry() {
    textEntry = true;
    draft = String(round3(unit.toDisplay(evaluated)));
    await Promise.resolve(); // let the input render before focusing it
    eqInputEl?.focus();
    eqInputEl?.select();
  }

  /** Escape during a number-mode scrub/nudge reverts the live preview (the
   * Property Panel's previous DraggableNumber-wrapper behavior). */
  function onWrapKeydown(e) {
    if (e.key === "Escape" && !showText) {
      app.cancelPreview();
      e.target.blur?.();
      e.stopPropagation();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="numfield" onkeydown={onWrapKeydown}>
  {#if showText}
    <span class="eq-wrap">
      <input
        bind:this={eqInputEl}
        type="text"
        class="eq-input"
        class:invalid
        class:error={!invalid && !!error}
        spellcheck="false"
        aria-label={`${label} equation`}
        value={draft}
        oninput={onEqInput}
        onfocus={() => (focused = true)}
        onblur={onEqBlur}
        onkeydown={onEqKeydown}
      />
      {#if !invalid && error}
        <Tooltip text={error}>
          <span class="eq-badge eq-badge-error">
            <iconify-icon icon="mdi:alert-circle-outline" width="13" height="13"></iconify-icon>
          </span>
        </Tooltip>
      {:else}
        <!-- Live evaluation, shown in DISPLAY units + suffix (degrees for
             rotation) so it matches the scrubber the field toggles from. -->
        <span class="eq-badge">= {invalid ? "?" : round3(unit.toDisplay(evaluated))}{unit.suffix}</span>
      {/if}
    </span>
  {:else}
    <!-- Equation affordance (round-11 ruling): on the LEFT of the value,
         HOVER-ONLY (revealed by .row:hover in app.css; hidden at rest so the
         resting field is just label + value). Clicking it opens the SAME
         symmetric text-entry path a click-without-drag opens — it is NOT a
         mode toggle (typed content still decides number vs equation); it's
         the explicit "little equation button" the user relented on. -->
    <Tooltip text="Enter an equation">
      <button
        class="eq-open"
        aria-label={`${label}: enter an equation`}
        onclick={beginTextEntry}
      >
        <iconify-icon icon="mdi:function-variant" width="14" height="14"></iconify-icon>
      </button>
    </Tooltip>
    <!-- `onedit` = DraggableNumber's click-without-drag hook (the generic lib
         capability). It DELEGATES text entry to beginTextEntry() so the ONE
         symmetric text path (number vs equation) lives here. The scrubber
         works in DISPLAY units (degrees for rotation); previewNumber/
         commitNumber convert back to stored (radians). `suffix` shows the
         unit indicator ("°") inside the standardized box. -->
    <DraggableNumber
      {label}
      value={round3(unit.toDisplay(evaluated))}
      min={min == null ? null : unit.toDisplay(min)}
      max={max == null ? null : unit.toDisplay(max)}
      coefficient={dragCoefficient}
      suffix={unit.suffix}
      oninput={previewNumber}
      onchange={commitNumber}
      onedit={beginTextEntry}
    />
  {/if}
</div>
