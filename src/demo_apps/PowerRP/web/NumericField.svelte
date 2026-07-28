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

  AUTOCOMPLETE (manifest "EQUATION DISCOVERABILITY"): while typing in the
  equation input, EquationSuggest.svelte renders a ranked dropdown (core/
  equationSuggest.js — pure candidate discovery + rp's fuzzy ranker) anchored
  under the field. Up/Down move the highlight, Tab/Enter accept the
  highlighted candidate (replacing the in-progress fragment, NOT committing
  the field — the user keeps editing), Escape dismisses the SUGGESTIONS first;
  a second Escape then reverts the field (the pre-existing behavior is
  UNCHANGED — the suggestion layer intercepts only when it's actually open).
-->
<script>
  import "iconify-icon";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import EquationSuggest from "./EquationSuggest.svelte";
  import { getPath } from "../core/deltas.js";
  import {
    displayToStored, storedToDisplay, compiled, evalAst,
    classifyEquation, equationTokenSpans, resolveRef, slugMap,
  } from "../core/expressions.js";
  import { suggestEquation, acceptSuggestion } from "../core/equationSuggest.js";
  import { decimalPlaces, resolveScrub } from "../../../lib/numberStep.js";
  import { displayUnit } from "./displayUnits.js";
  import { fanOutPairs } from "../core/multiselect.js";

  let { app, path, paths = null, label, min = null, max = null, display = null, scrub = null, step = null } = $props();

  /**
   * THE WRITE TARGETS. Reads stay on the singular `path` (the PRIMARY item — in a
   * multi-selection every selected item agrees on this value, or the row would be
   * showing the MIXED mark instead of this field), while WRITES fan out to all of
   * them. `paths` absent = the single-selection case, byte-identically as before.
   */
  let writePaths = $derived(paths ?? [path]);

  // The equation's OWNING item id, enabling `self.` completion — mirrors
  // evaluateState's own selfId derivation (core/expressions.js: "self resolves
  // to the item that OWNS the equation slot", slot.path[1] when
  // slot.path[0] === "items"). null for a Variables Panel row (path = ["vars", name]).
  let selfId = $derived(path[0] === "items" ? path[1] : null);

  // ── The property's DEFAULT value: the precision evidence ────────────────────
  // Read from THE PLUGIN, never from the row. A row cannot carry a default at
  // all: core/properties.js `row()` destructures it away (`const {default:
  // _drop, ...rowAspects}`, doctested as `row("cornerRadius").default //
  // undefined`) and `customProps()` moves it into the plugin's defaults object.
  // That strip is deliberate and older than this field — it landed with the
  // shared property registry itself, whose whole claim was that composed rows are
  // byte-identical to the hand-written rows they replaced, and whose reason for
  // existing was that a default living in two places drifts (the same commit
  // records having already lost rect's opacity default into a comment). So a
  // plugin's own `defaults` IS the source of truth, and this reads it there,
  // mirroring Inspector.svelte's existing `getPath(sel.plugin.defaults,
  // row.key.split("."))` precedent (item → plugin via
  // `registry.get(storedItemValue(id, ["type"]))`, app.svelte.js's own).
  //
  // There WAS a `defaultValue` prop here, taking precedence over this, wired from
  // Inspector.svelte as `defaultValue={row.default ?? null}` — null at every one
  // of the 1507 numeric rows, by the strip above, i.e. a branch that read as a
  // live per-row override and could never be taken. It is gone rather than
  // repaired: reinstating it would mean un-stripping `default` in `row()` and
  // mirroring every plugin default onto its row.
  //
  // A non-number default (an `=` equation string) is no precision evidence, so it
  // reads as absent.
  let propDefault = $derived.by(() => {
    // A Variables Panel row (["vars", name]) owns no plugin default, so its scrub
    // used to fall back to 1/px — useless for a variable holding, say, 0.3, whose
    // domain is otherwise unknowable. The CURRENT value's own magnitude IS
    // fractional evidence (resolveScrub source 3): feed it as the defaultValue so a
    // fractional variable scrubs by ~1% of itself per pixel, while an integer or 0
    // variable is left at 1/px (a count must not be re-scaled — the doctrine in
    // ../../../lib/numberStep.js). An equation string is no evidence.
    if (path[0] === "vars") {
      const cur = getPath(app.rawState(), path);
      return typeof cur === "number" ? cur : null;
    }
    if (path[0] !== "items") return null; // any other non-items row owns no plugin
    const plugin = app.registry.get(app.storedItemValue(path[1], ["type"]));
    const declared = plugin ? getPath(plugin.defaults, path.slice(2)) : undefined;
    return typeof declared === "number" ? declared : null;
  });

  // Scrub sensitivity (manifest "Number-slider sensitivity"): an explicit
  // per-row `scrub` coefficient wins (transition seconds = 0.1/px); otherwise
  // a BOUNDED row spans its full range across RANGE_DRAG_PX of drag — the fix
  // for opacity flicking 0↔1 (1px used to be a full unit). RANGE_DRAG_PX=100
  // is LINKED to the DraggableNumber demo's canonical 0..1 slider, which uses
  // coefficient 0.01 (= 100px full range).
  //
  // THIRD SOURCE (the fix for "palette offset is useless — I can't just do 0.1,
  // 0.2, 0.3, 0.4"): an UNBOUNDED row whose default is FRACTIONAL now scrubs its
  // own magnitude across the same RANGE_DRAG_PX run instead of falling back to a
  // whole unit per pixel. 55 rows were unusable that way — a 1px twitch on
  // `interiorThreshold` (default 1e-3) moved it by 1.0, i.e. by 1000× its own
  // value. Rows with no fractional evidence (x/y/w/h, counts, a 0 default) are
  // deliberately untouched at 1/px; the precedence and WHY live in
  // ../../../lib/numberStep.js. The step comes from the SAME call so the grid can
  // never be coarser than one pixel of drag (that pairing is the whole point of
  // resolveScrub — see its header's step ≤ coefficient invariant).
  const RANGE_DRAG_PX = 100;
  let scrubbing = $derived(
    resolveScrub({
      step,
      scrub,
      // Bounds AND the default are converted to DISPLAY units (rotation edits in
      // degrees though core stores radians), because the control they calibrate
      // works in display units. resolveScrub reads `min`/`max` as a span, so a
      // null bound must stay null rather than becoming toDisplay(null).
      min: min == null ? null : unit.toDisplay(min),
      max: max == null ? null : unit.toDisplay(max),
      defaultValue: propDefault == null ? null : unit.toDisplay(propDefault),
      dragPx: RANGE_DRAG_PX,
    }),
  );
  // A null coefficient means "nothing knowable" — keep DraggableNumber's own
  // 1 unit/px, which is what an unbounded positional row has always used.
  let dragCoefficient = $derived(scrubbing.coefficient ?? 1);

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

  // ── Reference special form (manifest "Equation special forms": REFERENCE) ──
  // A row whose stored value is a PURE, UNMODIFIED reference to a VARIABLE
  // renders as a SCRUBBER (not text) that WRITES THROUGH to that variable
  // (round-10 spec: "scrubbing a numeric reference edits the referenced
  // variable"). classifyEquation gives the special form; resolveRef gives the
  // target kind. VARIABLES ONLY: write-through to another item's PROPERTY would
  // silently edit a different item, so item-property/anchor references keep the
  // text field (see the field-header note + FLAG in the report). refTarget is
  // the {kind:"var", name} write-through target, or null (→ not a scrubber).
  // THE "=" MARKER COMES OFF FIRST — classifyEquation strips it internally and
  // resolveRef takes ONE TOKEN, so passing `stored` to both made the two disagree:
  // a `= speed` row classified as "reference" and then resolved to a variable
  // literally named "= speed", which cannot exist, so the scrubber silently never
  // appeared on any marker-form reference. Same strip idiom as buildHighlightPieces
  // below (core owns the marker's one regex; this is a read, not a rewrite).
  let refTarget = $derived.by(() => {
    if (!isEquation || textEntry) return null;
    const clean = String(stored).replace(/^\s*=\s*/, "");
    if (classifyEquation(clean) !== "reference") return null;
    try {
      const d = resolveRef(clean, slugMap(app.rawState()), selfId);
      // Variables only, and only if the variable actually exists (a dangling
      // reference stays as text so its error affordance shows).
      if (d.kind === "var" && d.name in (app.rawState().vars ?? {})) return d;
    } catch {
      // Unresolvable reference (purged item, typo): fall through to text so the
      // error affordance surfaces it — never silently swallow.
    }
    return null;
  });
  let showRefScrubber = $derived(refTarget != null);
  // The referenced variable's own state path — the write-through target.
  let refVarPath = $derived(refTarget ? ["vars", refTarget.name] : null);

  let showText = $derived((isEquation || textEntry) && !showRefScrubber);

  // ── Syntax highlight spans (manifest "Equation syntax highlighting") ────────
  // The overlay renders these BEHIND a transparent-text input; classes come
  // from the REAL tokenizer/resolver (equationTokenSpans), never a regex re-lex.
  // Recomputed from the live DRAFT (what the user sees) so highlighting tracks
  // typing before commit. Interleaved with the plain-text gaps in the markup.
  let highlightPieces = $derived(buildHighlightPieces(showText ? draft : ""));

  function buildHighlightPieces(text) {
    const clean = text.replace(/^\s*=\s*/, "");
    const lead = text.slice(0, text.length - clean.length); // preserved "= " prefix (plain)
    const spans = equationTokenSpans(clean, app.rawState(), selfId);
    const pieces = lead ? [{ text: lead, cls: null }] : [];
    let last = 0;
    for (const s of spans) {
      if (s.start > last) pieces.push({ text: clean.slice(last, s.start), cls: null }); // whitespace gap
      pieces.push({ text: clean.slice(s.start, s.end), cls: s.cls });
      last = s.end;
    }
    if (last < clean.length) pieces.push({ text: clean.slice(last), cls: null }); // trailing space
    return pieces;
  }

  // Keep the highlight overlay's horizontal scroll pinned to the input's, so a
  // long expression that scrolls past the box edge stays aligned under the caret.
  let highlightEl = $state(null);
  function syncScroll() {
    if (highlightEl && eqInputEl) highlightEl.scrollLeft = eqInputEl.scrollLeft;
  }

  // Keep the draft synced to the document while the user is NOT typing —
  // a bind:value-style local buffer avoids caret fights with live preview.
  $effect(() => {
    if (!focused) draft = isEquation ? storedToDisplay(stored, app.rawState()) : "";
  });

  // ── Autocomplete (manifest "EQUATION DISCOVERABILITY") ─────────────────────
  // Re-ranked on every keystroke from the CURRENT caret position (not just the
  // draft text) — the same fragment mid-expression ("box.x + 10 + spe|") must
  // suggest against "spe", not the whole draft. suggestionsOpen is a SEPARATE
  // flag from "candidates.length > 0" so one Escape can close an open list
  // without the next keystroke (if any) reopening it from stale candidates.
  let suggestionsOpen = $state(false);
  let highlighted = $state(0);
  let candidates = $derived(
    suggestionsOpen && eqInputEl
      ? suggestEquation(draft, eqInputEl.selectionStart ?? draft.length, app.rawState(), app.registry, selfId)
      : [],
  );
  // Clamp highlight when the candidate set shrinks (e.g. a keystroke narrows
  // the fuzzy match) so it never points past the end of a shorter list.
  $effect(() => {
    if (highlighted >= candidates.length) highlighted = Math.max(0, candidates.length - 1);
  });

  // Display rounding. Three decimals is the long-standing default for the shown
  // value, the text-entry pre-fill and the evaluated badge — but a row whose
  // resolved grid is FINER than that (a 1e-5 threshold) would have its value
  // quantized by the DISPLAY, and the scrubber would then fight its own rounding
  // (measured: interiorThreshold drifted 40% off its coefficient). So the shown
  // precision is the finer of the two: never coarser than the step it moves in.
  const SHOWN_DECIMALS = 3;
  let shownDecimals = $derived(
    Math.max(SHOWN_DECIMALS, scrubbing.step == null ? 0 : decimalPlaces(scrubbing.step)),
  );

  /** Pure-ish (reads the row's resolved grid). Rounds v for display; 0 for a
   * non-number, which is what an unevaluated slot shows. */
  function roundShown(v) {
    const scale = 10 ** shownDecimals;
    return typeof v === "number" ? Math.round(v * scale) / scale : 0;
  }

  // ── Number mode (DraggableNumber emits DISPLAY-unit numbers) ───────────────
  // DraggableNumber scrubs in the shown unit (degrees for rotation); we convert
  // back to the STORED unit (radians) before writing. Identity for normal rows.

  function previewNumber(shown) {
    app.setPreview(fanOutPairs(writePaths, unit.fromDisplay(shown)));
  }

  function commitNumber(shown) {
    app.setPreview(fanOutPairs(writePaths, unit.fromDisplay(shown)));
    app.commitPreview();
  }

  // ── Reference scrub write-through (round-10 spec) ──────────────────────────
  // Scrubbing a pure-VARIABLE-reference row edits the REFERENCED VARIABLE, not
  // the row (the row keeps its reference string). Bounds/scrub still come from
  // the ROW (the ratified rule: "variables don't own minimum or maximum
  // values"), so previewNumber/commitNumber's DraggableNumber wiring is reused
  // unchanged — only the write TARGET differs (refVarPath instead of path).
  // Display units apply to the SHOWN value; a variable stores a plain number.

  function previewRef(shown) {
    app.setPreview([[refVarPath, unit.fromDisplay(shown)]]);
  }

  function commitRef(shown) {
    app.setPreview([[refVarPath, unit.fromDisplay(shown)]]);
    app.commitPreview(); // one undo unit per scrub commit
  }

  // ── The ONE text-entry path (numbers AND equations) ────────────────────────

  /** Draft → stored-form string (throws on bad syntax/unknown refs). */
  function toStored(text) {
    return displayToStored(text, app.rawState());
  }

  function onEqInput(e) {
    draft = e.target.value;
    suggestionsOpen = true; // any edit re-opens/re-ranks (candidates is $derived on the caret)
    highlighted = 0;
    syncScroll(); // keep the highlight overlay aligned as the caret scrolls the input
    try {
      app.setPreview(fanOutPairs(writePaths, toStored(draft)));
      invalid = false;
    } catch {
      // Invalid draft: affordance only — the specific message would thrash
      // while typing; commit reports loudly if the user insists.
      app.cancelPreview();
      invalid = true;
    }
  }

  /** Command. Replaces the in-progress fragment with the accepted candidate
   * (core/equationSuggest.js acceptSuggestion) and re-previews — does NOT
   * commit the field (the user is still editing; Enter/blur commits as
   * usual). Keeps focus in the text input (never moves it to the dropdown),
   * closes the dropdown, and re-runs onEqInput's preview/invalid bookkeeping
   * via the same draft-mutation path so behavior stays single-sourced. */
  function acceptCandidate(candidate) {
    if (!candidate || !eqInputEl) return;
    const { text, cursor } = acceptSuggestion(draft, eqInputEl.selectionStart ?? draft.length, candidate.text);
    draft = text;
    suggestionsOpen = false;
    try {
      app.setPreview(fanOutPairs(writePaths, toStored(draft)));
      invalid = false;
    } catch {
      app.cancelPreview();
      invalid = true;
    }
    // Restore the caret right after the inserted text (not end-of-field —
    // there may be more expression after it, e.g. "self.end_wi| + 2").
    requestAnimationFrame(() => eqInputEl?.setSelectionRange(cursor, cursor));
    eqInputEl.focus();
  }

  /** Commits the draft; WHAT WAS TYPED decides the type (symmetric): a pure
   * numeric expression becomes a plain number, references make an equation. */
  function commitText() {
    suggestionsOpen = false;
    let storedForm;
    try {
      storedForm = toStored(draft);
    } catch (e) {
      console.error(`PowerRP: equation not committed: ${e.message}`);
      revertDraft();
      return;
    }
    const { ast, refs } = compiled(storedForm);
    // A pure numeric expression is entered in DISPLAY units (degrees) and
    // stored in core units (radians); an equation is stored verbatim (its
    // text is authored in stored-space references — unit conversion of
    // free-form expressions is out of scope, see the field header note).
    const value = refs.length === 0 ? unit.fromDisplay(evalAst(ast, () => 0)) : storedForm;
    app.setPreview(fanOutPairs(writePaths, value));
    app.commitPreview();
    invalid = false;
    endTextEntry();
  }

  /** Command. Closes the text editor and re-syncs the draft to what the document
   * now holds — so the blur that FOLLOWS an Enter sees no change and does not
   * commit a SECOND time (the one-undo-unit contract: keyframed() always returns a
   * fresh doc, so a second commit is a real duplicate undo entry and one undo then
   * only half-reverts). The AngleField.svelte endTextEntry precedent, verbatim. */
  function endTextEntry() {
    textEntry = false;
    focused = false;
    draft = currentText();
  }

  /** Query. The document's own text for the current value — what an UNTOUCHED
   * draft equals, so a focus/blur with no edit commits nothing (no undo entry).
   * The NUMBER branch matches beginTextEntry's pre-fill exactly (display units,
   * rounded), which is what "untouched" means for a number row. */
  function currentText() {
    return isEquation ? storedToDisplay(stored, app.rawState()) : String(roundShown(unit.toDisplay(evaluated)));
  }

  /** Command. Reverts to the document's value, discarding the live preview. */
  function revertDraft() {
    app.cancelPreview();
    invalid = false;
    endTextEntry();
  }

  /** Keyboard for the ONE text-entry path, autocomplete-aware:
   *   Up/Down     — move the suggestion highlight (only while open)
   *   Tab/Enter   — accept the highlighted suggestion IF the dropdown is
   *                 open (does not commit the field — see acceptCandidate);
   *                 Enter with the dropdown CLOSED still commits as before
   *   Escape      — closes an OPEN dropdown first (one keystroke, field
   *                 untouched); a SECOND Escape (dropdown already closed)
   *                 falls through to the pre-existing revert-the-field
   *                 behavior, UNCHANGED. Gated on candidates.length (not just
   *                 suggestionsOpen) so Escape reverts IMMEDIATELY when
   *                 nothing is actually showing — no invisible "eaten"
   *                 keystroke. */
  function onEqKeydown(e) {
    const hasSuggestions = suggestionsOpen && candidates.length > 0;
    if (hasSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length;
      e.preventDefault();
    } else if (hasSuggestions && (e.key === "Tab" || e.key === "Enter")) {
      acceptCandidate(candidates[highlighted]);
      e.preventDefault();
    } else if (e.key === "Enter") {
      commitText();
      e.target.blur();
    } else if (e.key === "Escape" && hasSuggestions) {
      suggestionsOpen = false;
      e.stopPropagation(); // dismiss-only: field/draft untouched, don't bubble into Deselect
    } else if (e.key === "Escape") {
      revertDraft();
      e.target.blur();
      e.stopPropagation(); // don't let Escape bubble into Deselect
    }
  }

  /** Settles the field on blur — but ONLY if something actually changed, so
   * tabbing through a field (or the blur that FOLLOWS an Enter/Escape, which
   * already re-synced the draft) never writes a no-op undo entry. */
  function onEqBlur() {
    focused = false;
    suggestionsOpen = false;
    if (invalid || textEntry || draft !== currentText()) commitText();
  }

  /** Opens keyboard text entry pre-filled with the current value — the seam
   * DraggableNumber's click-without-drag plugs into (see header comment).
   * Pre-fill is in DISPLAY units (degrees for rotation) to match what the
   * number scrubber showed. */
  async function beginTextEntry() {
    textEntry = true;
    draft = String(roundShown(unit.toDisplay(evaluated)));
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
      <!-- Syntax highlight overlay (manifest "Equation syntax highlighting"):
           the colorized equation rendered BEHIND the input. The input's own text
           is transparent (app.css .eq-input color:transparent) with a native
           visible caret/selection, so caret behavior and metrics stay 100%
           native; this layer only paints color. Same font/padding/scroll as the
           input (app.css) keeps every glyph pixel-aligned. aria-hidden: it is
           decoration; the input carries the accessible value. DESIGN BOUND: the
           overlay TECHNIQUE generalizes to multi-line (an absolutely-positioned
           colored layer under a transparent editor) — a future language editor
           swaps this <span> run for a per-line run of the same pieces. -->
      <div class="eq-highlight" bind:this={highlightEl} aria-hidden="true">
        {#each highlightPieces as p}{#if p.cls}<span class="eq-tok eq-tok-{p.cls}">{p.text}</span>{:else}{p.text}{/if}{/each}
      </div>
      <input
        bind:this={eqInputEl}
        type="text"
        class="eq-input"
        data-hint-scope="commit"
        class:invalid
        class:error={!invalid && !!error}
        spellcheck="false"
        aria-label={`${label} equation`}
        value={draft}
        oninput={onEqInput}
        onscroll={syncScroll}
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
        <span class="eq-badge">= {invalid ? "?" : roundShown(unit.toDisplay(evaluated))}{unit.suffix}</span>
      {/if}
      <EquationSuggest
        {candidates}
        {highlighted}
        anchorEl={eqInputEl}
        onhover={(i) => (highlighted = i)}
        onpick={acceptCandidate}
      />
    </span>
  {:else if showRefScrubber}
    <!-- REFERENCE scrub write-through (manifest "Equation special forms" +
         round-10 spec): the stored value is a pure, unmodified reference to a
         VARIABLE, so the row is a SCRUBBER affordanced as a reference — the
         path tooltip shows what it points at (the existing path-tooltip
         machinery), a link glyph on the LEFT marks it as a reference (mirrors
         the ƒ affordance's placement), and scrubbing WRITES THROUGH to the
         variable (previewRef/commitRef target ["vars", name]). The row is NOT
         demoted to a number: its stored reference string is untouched; only the
         variable's value changes, so every OTHER equation reading that variable
         follows live. Bounds/scrub come from the ROW (min/max/scrub props), the
         ratified rule — a variable owns no min/max. onedit (click-without-drag)
         still opens the equation text path so the reference can be retargeted. -->
    <Tooltip text={`References ${storedToDisplay(stored, app.rawState())} — scrubbing edits the variable`}>
      <span class="eq-ref-mark" aria-hidden="true">
        <iconify-icon icon="mdi:link-variant" width="13" height="13"></iconify-icon>
      </span>
    </Tooltip>
    <DraggableNumber
      label={`${label} (reference to ${storedToDisplay(stored, app.rawState())})`}
      value={roundShown(unit.toDisplay(evaluated))}
      min={min == null ? null : unit.toDisplay(min)}
      max={max == null ? null : unit.toDisplay(max)}
      coefficient={dragCoefficient}
      step={scrubbing.step}
      suffix={unit.suffix}
      oninput={previewRef}
      onchange={commitRef}
      onedit={beginTextEntry}
    />
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
    <!-- `step` is RESOLVED here rather than left to DraggableNumber's own
         defaultValue fallback: the grid and the per-pixel coefficient are one
         decision (resolveScrub), so a row can never end up with a grid coarser
         than one pixel of its own drag. DraggableNumber keeps that fallback for
         standalone lib consumers; this field, which knows the row's scrub and
         bounds too, supplies the answer outright. -->
    <DraggableNumber
      {label}
      value={roundShown(unit.toDisplay(evaluated))}
      min={min == null ? null : unit.toDisplay(min)}
      max={max == null ? null : unit.toDisplay(max)}
      coefficient={dragCoefficient}
      step={scrubbing.step}
      suffix={unit.suffix}
      oninput={previewNumber}
      onchange={commitNumber}
      onedit={beginTextEntry}
    />
  {/if}
</div>
