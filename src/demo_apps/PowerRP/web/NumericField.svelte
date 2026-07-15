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
  SEAM: from number mode, text entry is meant to open on a CLICK-WITHOUT-DRAG
  on the scrubber — a GENERIC DraggableNumber capability that lands in
  src/lib separately. It is wired here already via the `onedit` prop below:
  the day DraggableNumber emits onedit, this field lights up with no further
  app changes. Until then, equation fields (already-string values) are the
  reachable text-entry surface.

  Live preview: valid drafts preview via app.setPreview (viewport re-renders
  in real time, manifest rule); Enter/blur commits (one undo unit); Escape
  reverts. Invalid drafts show the invalid affordance and cancel the preview.
  Evaluation errors (cycles, unknown refs) show the error affordance with the
  message from the derivation stage's error map.

  Props: app, path (full state path, e.g. ["items", id, "x"] or
  ["vars", name]), label, min/max (DraggableNumber bounds).
  Styling lives in app.css (.numfield / .eq-*; app convention: no <style>).
-->
<script>
  import "iconify-icon";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { getPath } from "../core/deltas.js";
  import { displayToStored, storedToDisplay, compiled, evalAst } from "../core/expressions.js";

  let { app, path, label, min = null, max = null } = $props();

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

  // ── Number mode (DraggableNumber emits numbers) ────────────────────────────

  function previewNumber(v) {
    app.setPreview([[path, v]]);
  }

  function commitNumber(v) {
    app.setPreview([[path, v]]);
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
    const value = refs.length === 0 ? evalAst(ast, () => 0) : storedForm;
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
   * DraggableNumber's click-without-drag plugs into (see header comment). */
  async function beginTextEntry() {
    textEntry = true;
    draft = String(round3(evaluated));
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
        <span class="eq-badge">= {invalid ? "?" : round3(evaluated)}</span>
      {/if}
    </span>
  {:else}
    <!-- SEAM: `onedit` is DraggableNumber's future click-without-drag hook
         (generic lib capability, landing separately). Unknown props are
         ignored today; when the lib emits it, typing-into-a-number works
         everywhere with no further changes here. -->
    <DraggableNumber
      {label}
      value={round3(evaluated)}
      min={min ?? null}
      max={max ?? null}
      oninput={previewNumber}
      onchange={commitNumber}
      onedit={beginTextEntry}
    />
  {/if}
</div>
