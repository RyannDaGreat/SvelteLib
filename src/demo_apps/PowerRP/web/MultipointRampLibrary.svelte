<!--
  MultipointRampLibrary — the 1-D RAMP LIBRARY applied to a Multipoint fill's COLOURS,
  geometry untouched (manifest: "Colour brainstorming from the ramp library"). Two
  modes, one component, mounted by the Inspector (web/MultipointField.svelte) and the
  canvas island (web/MultipointIsland.svelte):

    mode "fill" — GRADIENT MAP: every colour of the fill becomes the ramp colour at its
                  lightness. `path` = the {features, …} sub-state's document path.
    mode "path" — RAMP ALONG ONE PATH source's arc length, on Both / Left / Right side.
                  `path` = the source's document path.

  It is GradientPresetPicker (the same library the linear/radial stop list offers)
  with Multipoint writes: hover stages app.setPreview, leaving the grid cancels, a
  click commits ONE undo unit. The pairs come from web/multipointRecolor.js, which
  reads the COMMITTED fold so a sweep across ramps never compounds.

  No <style> block (app convention): .multipoint-ramp-* rules live in app.css; the
  side/Reverse toggles reuse .paint-type-tabs / .paint-type-tab.
-->
<script>
  import GradientPresetPicker from "./GradientPresetPicker.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { RAMP_SIDES, RAMP_SIDE_LABELS, gradientMapPairs, pathRampPairs } from "./multipointRecolor.js";

  let {
    app, mode, path, disabled = false,
    open = $bindable(false), showToggle = true,
    twoSided = false, // path mode: offer the side tabs
    onopenchange = null,
  } = $props();

  const LABELS = { fill: "Recolour from gradient", path: "Ramp along path" };
  const ICONS = { fill: "mdi:palette-swatch-variant", path: "mdi:gradient-horizontal" };
  const HELP = {
    fill: "Hover a gradient to see the whole fill recoloured by lightness (dark colours take the gradient's start, light ones its end); click to keep it. Shapes and positions never move.",
    path: "Hover a gradient to lay it along this path; click to keep it. Replaces this source's colour stops.",
  };

  let side = $state("both");
  let reversed = $state(false);
  let skipped = $state([]);
  let previewing = false;

  /** Query. The pairs for `ramp` in this mode; records what a gradient map skipped. */
  function pairsFor(ramp) {
    if (mode === "path") return pathRampPairs(app, path, ramp, { side, reversed });
    const map = gradientMapPairs(app, path, ramp, { reversed });
    skipped = map.skipped;
    return map.pairs;
  }

  /** Command. Stages the recolour as a live preview (no document change, no undo). */
  function preview(ramp) {
    if (disabled) return;
    app.setPreview(pairsFor(ramp));
    previewing = true;
  }

  /** Command. Reverts only the preview this library staged. */
  function cancelPreview() {
    if (!previewing) return;
    app.cancelPreview();
    previewing = false;
  }

  /** Command. Applies the recolour as ONE undo unit. */
  function pick(ramp) {
    if (disabled) return;
    app.setPreview(pairsFor(ramp));
    app.commitPreview();
    previewing = false;
  }
</script>

{#snippet options()}
  <div class="multipoint-ramp-options">
    {#if mode === "path" && twoSided}
      <div class="paint-type-tabs" role="group" aria-label="Which side takes the gradient">
        {#each RAMP_SIDES as s (s)}
          <button type="button" class="paint-type-tab" aria-pressed={side === s} onclick={() => { side = s; }}>{RAMP_SIDE_LABELS[s]}</button>
        {/each}
      </div>
    {/if}
    <Tooltip text={mode === "fill" ? "Map dark colours to the gradient's END instead of its start." : "Run the gradient from the path's end instead of its start."}>
      <button type="button" class="paint-type-tab multipoint-ramp-reverse" aria-pressed={reversed} onclick={() => { reversed = !reversed; }}>Reverse</button>
    </Tooltip>
  </div>
  {#if mode === "fill" && skipped.length}
    <p class="paint-stops-multi-note">Left unchanged: {skipped.join("; ")}.</p>
  {/if}
{/snippet}

<div class="multipoint-ramp-library" data-mode={mode}>
  <GradientPresetPicker {disabled} bind:open {showToggle} revealOnOpen={showToggle} toggleLabel={LABELS[mode]} toggleIcon={ICONS[mode]} toggleHelp={HELP[mode]}
    bodyHeader={options} onpick={pick} onpreview={preview} oncancelpreview={cancelPreview}
    onopenchange={(o) => { if (!o) cancelPreview(); onopenchange?.(o); }} />
</div>
