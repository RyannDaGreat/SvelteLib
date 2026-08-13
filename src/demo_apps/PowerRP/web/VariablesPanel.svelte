<!--
  Global Variables Panel — the keyframable GLOBAL variables editor (THE
  UNIFICATION). Named "Global Variables" on its name plate and in its
  "Toggle Visibility: Global Variables Panel" command (user ruling: "the
  variables panel should now be called the global variables panel, because
  they're global variables") — the per-ITEM variables are a different surface,
  the Property Panel's own Variables category (web/ItemVariablesPanel.svelte),
  and calling both "Variables" is what made the distinction invisible. The file
  and component names stay VariablesPanel: the rename is user-facing only.
  The panel is HIDDEN BY DEFAULT (core/panels.js defaultVisible: false).

  Variables live in state.vars ({name: value | equation}) and tween like any
  state: keyframe a variable per slide and every equation referencing it
  follows the tween. Each row mirrors a Property Panel row: name (rename
  rewrites references document-wide — a variable's name IS its identity),
  a KIND picker, an equation-aware field for the value, and the standard ‹ ◆ ›
  keyframe controls on path ["vars", name]. Delete removes the variable from
  existence (all keyframes, all slides — the variables' Purge). The add row
  creates the variable keyframed at its kind's zero on the CURRENT slide (same
  visibility philosophy as item creation: things begin on the slide where you
  make them).

  ── THE KIND PICKER (workstream COMPOUND_, backburner CX) ────────────────────
  User: "It does seem that global variables don't have any ability to set type
  inside the UI. That's a bit of a bug. There are several types of properties. We
  should be able to set which type of property a given variable is as a global
  variable."

  It was a UI bug and not a model one — `state.vars` always held any JSON value,
  but this panel only ever mounted a NumericField, so a colour variable was
  expressible in the document and unreachable in the app. The picker is a small
  select in the row's LABEL cell, beside the name, and it drives which field the
  value column mounts. Every rule (where the kind is stored, why it is meta and
  not fold state, what each kind's zero is, why a retype resets the value) lives
  in core/var_kinds.js; this file only renders it.

  THE VALUE FIELD IS THE PROPERTY PANEL'S OWN. A colour variable mounts the same
  ColorField a fill row does, a boolean the same BooleanField, a font the same
  Dropdown over the same `fontOptions()` roster the text widget reads — so a
  variable's editor cannot drift from the editor of the property it will be bound
  to, and a face added to the font registry appears in both at once.

  Styling lives in app.css (.varspanel; app convention: no <style> blocks).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import NumericField from "./NumericField.svelte";
  import ColorField from "./ColorField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import LabelDivider from "./LabelDivider.svelte";
  import { VAR_KINDS, VAR_KIND_LABELS, VAR_KIND_NOTES, fontVarRowAspects } from "../core/var_kinds.js";
  import { getPath } from "../core/deltas.js";

  let { app } = $props();

  let names = $derived(Object.keys(app.varsState()));
  let newName = $state("");
  // THE ADD ROW'S KIND, chosen BEFORE the variable exists — a variable is created
  // already keyframed at its kind's zero, so the kind has to be known at creation
  // rather than set afterwards on a value that was born the wrong type.
  let newKind = $state("number");

  const KIND_ITEMS = VAR_KINDS.map((k) => ({ value: k, label: VAR_KIND_LABELS[k] }));

  function addVar() {
    if (!newName.trim()) return;
    if (app.addVariable(newName.trim(), newKind)) newName = "";
  }

  function renameVar(oldName, e) {
    if (!app.renameVariable(oldName, e.target.value.trim())) e.target.value = oldName;
  }

  /** Query. A variable's RAW stored value — raw, so an equation string reaches the
   *  fields as an equation rather than being coerced into a literal. */
  function rawValue(name) {
    return getPath(app.rawState(), ["vars", name]);
  }

  /** Query. The FONT kind's options, read at render time rather than at import:
   *  `registerFontFamily` can add faces while the app runs, and a snapshot would
   *  show a picker missing the font the author just loaded. */
  let fontAspects = $derived(fontVarRowAspects());

  /** Command. Live-preview a value the way every Property Panel field does — the
   *  viewport re-renders, the document is untouched until commit. Used by the
   *  kinds whose control commits through this panel rather than writing itself. */
  function previewValue(name, value) {
    app.setPreview([[["vars", name], value]]);
  }
  function commitValue(name, value) {
    app.setPreview([[["vars", name], value]]);
    app.commitPreview();
  }
</script>

<div class="varspanel">
  <!-- The variable rows are wrapped in a .rows BLOCK (the Inspector's container,
       reused) for two reasons that are really one: it is the measuring box the
       label⟷value divider reads, and it is the box the divider spans. Without it
       the divider would have to measure the whole panel — including the add-row
       below, which opts OUT of the value-column grid — and would then sit a few
       pixels off the boundary it is supposed to name. The rows themselves are
       unchanged; only their parent is new. -->
  <div class="rows">
    <!-- ONE fraction, both panels: the divider here and the ones in the Property
         Panel are readouts of app.labelFrac, so dragging either keeps the two
         panels' columns in x-sync (the round-11 "columns line up" ruling). -->
    {#if names.length > 0}<LabelDivider {app} />{/if}
    {#each names as name (name)}
      {@const kind = app.variableKind(name)}
      <div class="row">
        <span class="var-ident">
          <!-- THE KIND PICKER sits in the LABEL cell, ahead of the name, because
               it is a statement about WHAT THIS VARIABLE IS — the same half of the
               row the Property Panel puts a property's identity in. Putting it in
               the value cell would have made it compete with the value's own
               control for the one column both would need. -->
          <Tooltip text={VAR_KIND_NOTES[kind]}>
            <span class="var-kind">
              <Dropdown
                items={KIND_ITEMS}
                value={kind}
                onchange={(k) => app.setVariableKind(name, k)}
              />
            </span>
          </Tooltip>
          <input
            type="text"
            class="var-name"
            aria-label="Variable name"
            value={name}
            onchange={(e) => renameVar(name, e)}
          />
        </span>
        <!-- THE VALUE, edited by its KIND'S OWN FIELD — the Property Panel's, not
             a variables-only copy. Every one of these writes ["vars", name]
             itself (preview on drag/hover, commit as one undo unit), exactly as
             the same component does on an item row. -->
        {#if kind === "color"}
          <ColorField {app} path={["vars", name]} label={name} value={rawValue(name)} />
        {:else if kind === "boolean"}
          <BooleanField {app} path={["vars", name]} label={name} value={rawValue(name)} />
        {:else if kind === "font"}
          <!-- A font IS a select over the registry's ids, so it renders the plain
               Dropdown a `kind: "select"` property row does. It previews on hover
               like every other select: the same live-preview contract (viewport
               re-renders, document untouched, only a real pick commits). -->
          <Dropdown
            items={fontAspects.options.map((v) => ({ value: v, label: fontAspects.optionLabels[v] }))}
            value={rawValue(name)}
            onpreview={(v) => previewValue(name, v)}
            oncancelpreview={() => app.cancelPreview()}
            onchange={(v) => commitValue(name, v)}
          />
        {:else if kind === "text"}
          <input
            type="text"
            class="var-text"
            aria-label={`${name} value`}
            value={typeof rawValue(name) === "string" ? rawValue(name) : ""}
            oninput={(e) => previewValue(name, e.target.value)}
            onchange={(e) => commitValue(name, e.target.value)}
            onkeydown={(e) => e.stopPropagation()}
          />
        {:else}
          <NumericField {app} path={["vars", name]} label={name} />
        {/if}
        <!-- Trailing controls grouped in ONE grid cell (matches the Property
             Panel rows): the shared ‹ ◆ › KeyframeControls + a delete button
             appended in the same cell. Keeps the value column growing while these
             stay aligned across both panels. -->
        <span class="kf-controls">
          <KeyframeControls {app} path={["vars", name]} />
          <Tooltip text="Delete variable (all keyframes, all slides)">
            <button class="remove" aria-label="Delete variable" onclick={() => app.deleteVariable(name)}>
              <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
            </button>
          </Tooltip>
        </span>
      </div>
    {:else}
      <div class="empty">No variables — add one below, then reference it from any property (e.g. "speed * 2", or a colour variable as a widget's fill)</div>
    {/each}
  </div>
  <div class="row add-row">
    <Tooltip text={VAR_KIND_NOTES[newKind]}>
      <span class="var-kind">
        <Dropdown items={KIND_ITEMS} value={newKind} onchange={(k) => (newKind = k)} />
      </span>
    </Tooltip>
    <input
      type="text"
      class="var-name"
      data-hint-scope="add"
      placeholder="new_variable"
      aria-label="New variable name"
      spellcheck="false"
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") addVar();
        e.stopPropagation(); // typing must not trigger app shortcuts
      }}
    />
    <Tooltip text={`Add a ${VAR_KIND_LABELS[newKind]} variable (keyframed on this slide)`}>
      <button class="btn" onclick={addVar}>Add</button>
    </Tooltip>
  </div>
</div>
