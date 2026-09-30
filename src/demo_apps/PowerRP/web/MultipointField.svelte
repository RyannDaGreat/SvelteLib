<!-- Native Multipoint source editor. All coordinates/handles are fractions of
     the paint box; nodes and arc-length colours have independent list addresses. -->
<script>
  import ListField from "./ListField.svelte";
  import GradientPresetPicker from "./GradientPresetPicker.svelte";
  import { MULTIPOINT_PRESET_FAMILIES, getMultipointPreset } from "../core/multipoint_presets.js";
  import NumericField from "./NumericField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import LabelDivider from "./LabelDivider.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { LABEL_DIVIDER_VARIABLE } from "./labelFrac.js";
  import { getPath } from "../core/deltas.js";
  import { elementActive } from "../core/lists.js";
  import { MULTIPOINT_FEATURES_LIST, MULTIPOINT_NODES_LIST, MULTIPOINT_STOPS_LIST } from "../core/properties.js";
  import { multipointFeature, insertFeatureNode, reverseFeature } from "../core/multipoint.js";

  let { app, path, label, disabled = false, seedColor = "#7aa2f7" } = $props();
  const SOURCE_ROWS = MULTIPOINT_FEATURES_LIST.element.fields.filter((f) => f.kind !== "list");
  // One box-unit over a normal 100px scrub, including unbounded handle offsets.
  const BOX_SCRUB = 1 / 100;
  const NODE_DECL = { ...MULTIPOINT_NODES_LIST, element: {
    ...MULTIPOINT_NODES_LIST.element,
    fields: MULTIPOINT_NODES_LIST.element.fields.map((f) => ({ ...f, scrub: BOX_SCRUB })),
  } };
  const SOURCE_KINDS = ["point", "line", "curve"];
  // One picker section per catalog family (core/multipoint_presets.js owns order and titles).
  const PRESET_FAMILIES = MULTIPOINT_PRESET_FAMILIES.map((family) => ({ id: family.id, title: family.title,
    presets: family.presets.map((p) => ({ ...p, name: p.label })),
  }));
  const thumbnails = import.meta.glob("./multipoint_thumbnails/*.png", { eager: true, import: "default", query: "?url" });
  let presetsOpen = $state(false);
  let previewingPreset = false;
  let sourceListBound = $derived(!Array.isArray(getPath(app.rawState(), [...path, "features"]))
    || typeof getPath(app.rawState(), [...path, "featuresActive"]) === "string");

  /**
   * Pure function. Copies editable preset data and explicitly resets visibility.
   * @param {object} preset - Catalog entry.
   * @returns {object} Fresh Multipoint substate, ready for a sparse preview delta.
   * @example copyPreset({id:"warm-bokeh"}).features.length // 9
   */
  function copyPreset(preset) {
    const state = getMultipointPreset(preset.id).multipoint;
    return { ...state, featuresActive: null,
      features: state.features.map((f) => ({ ...f, nodesActive: null, stopsActive: null })),
    };
  }

  /**
   * Query. Returns the build's actual solver-rendered preset thumbnail URL.
   * @param {object} preset - Catalog entry with a permanent id.
   * @returns {string} CSS background image, never a substitute linear gradient.
   */
  function swatchStyle(preset) {
    const url = thumbnails[`./multipoint_thumbnails/${preset.id}.png`];
    if (!url) throw new Error(`Missing Multipoint thumbnail: ${preset.id}`);
    return `url("${url}") center / cover`;
  }

  /** Command. Stages native preset data without changing the document or undo. */
  function previewPreset(state) {
    if (disabled) return;
    app.setPreview([[path, state]]);
    previewingPreset = true;
  }

  /** Command. Cancels only the preview owned by this picker. */
  function cancelPresetPreview() {
    if (!previewingPreset) return;
    app.cancelPreview();
    previewingPreset = false;
  }

  /** Command. Applies a native preset as one undo unit, retaining paint-level settings. */
  function pickPreset(state) {
    previewPreset(state);
    app.commitPreview();
    previewingPreset = false;
  }

  /**
   * Command. Commits one nested value as one undo unit.
   * @param {Array} target - Full document path.
   * @param {*} value - New value, possibly reactive.
   * @returns {void}
   */
  function commit(target, value) {
    app.setPreview([[target, structuredClone($state.snapshot(value))]]);
    app.commitPreview();
  }

  /**
   * Command. Appends a typed source without renumbering existing sources.
   * @param {"point"|"line"|"curve"} kind - Initial geometry.
   * @returns {void}
   */
  function addSource(kind) {
    if (disabled) return;
    const stored = getPath(app.rawState(), path);
    const features = stored?.features ?? [];
    // A missing companion entry already means visible. Keep the existing
    // visibility data/equations verbatim instead of materializing a new array.
    commit(path, { ...stored, features: [...features, multipointFeature(kind, seedColor)] });
  }

  /**
   * Command. Splits the cubic at this insertion seam, including neighbour handles.
   * @param {Array} featurePath - Source's full state path.
   * @param {number} index - Node insertion slot.
   * @returns {void}
   */
  function insertNode(featurePath, index) {
    if (disabled) return;
    commit(featurePath, insertFeatureNode(getPath(app.rawState(), featurePath), index));
  }

  /**
   * Command. Reverses geometry and arc-length colours together, preserving sides.
   * @param {Array} featurePath - Source's full state path.
   * @returns {void}
   */
  function reverse(featurePath) {
    if (disabled) return;
    commit(featurePath, reverseFeature(getPath(app.rawState(), featurePath)));
  }
</script>

{#snippet sourceContent(feature, index, featurePath)}
  {@const sourceLabel = `${label} source ${index + 1}`}
  {@const point = feature.nodes.filter((_, i) => elementActive(feature.nodesActive, i)).length === 1}
  {@const firstColour = feature.stops.findIndex((_, i) => elementActive(feature.stopsActive, i))}
  {@const stored = getPath(app.rawState(), featurePath)}
  {@const featureBound = !stored || typeof stored !== "object"}
  {@const nodesBound = !Array.isArray(stored?.nodes) || typeof stored?.nodesActive === "string"}
  {@const stopsBound = !Array.isArray(stored?.stops) || typeof stored?.stopsActive === "string"}
  {@const nodeVisibilityEquation = Object.values(stored?.nodesActive ?? {}).some((v) => typeof v === "string")}
  {@const insertProblem = nodesBound || stored.nodes.some((node) => !Array.isArray(node) || node.some((v) => !Number.isFinite(v))) || typeof stored.closed === "string" || nodeVisibilityEquation
    ? "Insert unavailable: edit node/visibility/Closed equations first; splitting needs stored numeric geometry." : null}
  {@const reverseProblem = nodesBound || stopsBound || stored.stops.some((stop) => !Number.isFinite(stop.offset)) || typeof stored.twoSided === "string" || typeof stored.closed === "string" || nodeVisibilityEquation || Object.values(stored.stopsActive ?? {}).some((v) => typeof v === "string")
    ? "Reverse unavailable: edit geometry/offset/visibility/Closed/Two sides equations first." : null}
  <div class="multipoint-source" inert={disabled || featureBound}>
    <div class="paint-sub-rows" style:--a-label-frac={app.labelFrac[LABEL_DIVIDER_VARIABLE]}>
      <LabelDivider {app} dividerKey={LABEL_DIVIDER_VARIABLE} />
      {#each SOURCE_ROWS.filter((f) => !point || f.name === "weight") as row (row.name)}
        {@const fieldPath = [...featurePath, row.name]}
        <div class="paint-sub-row">
          <Tooltip text={row.help}><span class="paint-sub-label">{row.label}</span></Tooltip>
          <span class="paint-sub-control">
            {#if row.kind === "number"}
              <NumericField {app} path={fieldPath} label={`${sourceLabel} ${row.label}`} min={row.min ?? null} value={feature[row.name]} />
            {:else}
              <BooleanField {app} path={fieldPath} label={`${sourceLabel} ${row.label}`} value={feature[row.name]} {disabled} />
            {/if}
          </span>
          <span class="kf-controls">{#if !disabled}<KeyframeControls {app} path={fieldPath} />{/if}</span>
        </div>
      {/each}
    </div>
    {#if !point}
      <Tooltip text={reverseProblem ?? "Reverse traversal and colours while keeping the physical sides unchanged."}>
        <button type="button" class="btn" disabled={disabled || !!reverseProblem} aria-label={`Reverse ${sourceLabel}`} onclick={() => reverse(featurePath)}>Reverse</button>
      </Tooltip>
    {/if}
    {#if nodesBound || stopsBound}
      <p class="paint-stops-multi-note">Equation-driven lists are read-only here. Edit the list equation rather than replacing its computed elements.</p>
    {/if}
    <ListField {app} decl={NODE_DECL} path={[...featurePath, "nodes"]} label={`${sourceLabel} node`} disabled={disabled || nodesBound}
      keepExpandedDuringPreview={true} preserveStoredElements={true}
      insertDisabledReason={insertProblem}
      fieldVisible={(_, f) => !point || f.name === "x" || f.name === "y"}
      oninsert={(at) => insertNode(featurePath, at)}
      insertHelp="Insert a shaping node: split the Bézier segment, or extend an open end. Colours stay independent." />
    <ListField {app} decl={MULTIPOINT_STOPS_LIST} path={[...featurePath, "stops"]} label={`${sourceLabel} colour`} disabled={disabled || stopsBound}
      keepExpandedDuringPreview={true} preserveStoredElements={true} allowInsert={!point}
      fieldVisible={(_, f, i) => point ? i === firstColour && f.name === "color" : f.name !== "rightColor" || feature.twoSided}
      seedElement={{ offset: 0, color: seedColor, rightColor: seedColor }} />
    {#if point && feature.stops.length > 1}
      <p class="paint-stops-multi-note">Point uses first visible colour only. Other colours stay stored for paths.</p>
    {/if}
  </div>
{/snippet}

<div class="multipoint-field">
  <div class="multipoint-presets">
    <GradientPresetPicker {disabled} families={PRESET_FAMILIES} {copyPreset} {swatchStyle}
      onpick={pickPreset} onpreview={previewPreset} oncancelpreview={cancelPresetPreview}
      onopenchange={(open) => { presetsOpen = open; if (!open) cancelPresetPreview(); }} />
  </div>
  <div class="multipoint-actions">
    {#each SOURCE_KINDS as kind}
      <Tooltip text={presetsOpen ? "Close the preset library to edit individual sources." : `Add a ${kind} colour source`}>
        <button type="button" class="btn" disabled={disabled || presetsOpen || sourceListBound} aria-label={`${label}: add ${kind} source`} onclick={() => addSource(kind)}>+{kind[0].toUpperCase() + kind.slice(1)}</button>
      </Tooltip>
    {/each}
  </div>
  {#if sourceListBound}
    <p class="paint-stops-multi-note">Sources or their visibility are equation-driven. Edit the list equation or deliberately replace it with a preset.</p>
  {/if}
  <ListField {app} decl={MULTIPOINT_FEATURES_LIST} path={[...path, "features"]} label="Source" disabled={disabled || sourceListBound}
    allowInsert={false} keepExpandedDuringPreview={true} preserveStoredElements={true}
    forceCollapsed={presetsOpen} elementContent={sourceContent} />
</div>
