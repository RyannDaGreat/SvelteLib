<!--
  GradientPresetPicker — a Photoshop-style TILED LIBRARY of COLOUR-RAMP presets. A
  "Preset library" toggle reveals a searchable, family-grouped grid of little ramp
  swatches; clicking one REPLACES the ramp being edited with that preset's (via the
  onpick callback).

  IT SERVES ANY RAMP, not only a gradient paint. The library is DECLARED by the
  mount point (`families`, assembled once in web/ramp_preset_families.js) and a
  preset record is a whole RAMP VALUE — {name, stops, loop, space} — so the six
  cyclic OKLab palettes a Mandelbrot viewer needs and the 343 clamped sRGB
  gradients baked from the `rp` Python library sit in ONE grid and land correctly
  in either consumer with no branch here. Presets are DATA.

  MOUNTED FROM THE LIST DECLARATION, not by one field: web/ListField.svelte renders
  this above the stop rows whenever the declaration says `presets:
  COLOR_RAMP_LIBRARY` (core/properties.js). It used to be mounted privately by
  web/PaintField.svelte, which is why no other property could have a library.

  WHY inline expansion (not a floating popover): this field lives in the
  Inspector, whose scroll/overflow would clip an absolutely-positioned popover —
  the same reason ColorField expands inline. The revealed grid lives in the
  panel's own flow (it can't be clipped or mispositioned) and simply pushes the
  rows below it down; the panel scrolls. The grid itself is height-capped and
  scrolls internally so a 343-swatch library never runs off the panel.

  HOVERING a swatch LIVE-PREVIEWS its gradient on the selected item, mirroring
  ToolsPane's preset card grid: each pointerenter overwrites the last preview, and
  leaving the GRID (not each swatch — moving between neighbours must not flicker
  a revert) cancels it. The picker owns no document write of its own: it hands
  the stop list to the callbacks, and the mount point (PaintField) stages it
  through app.setPreview / app.cancelPreview, so the document is never mutated
  and no undo entry is created until a click commits.

  No <style> block (web/ app convention): classes live in app.css
  (.gradient-presets / .gradient-swatch / .gradient-presets-family / … via --a-*
  tokens). Each swatch's
  gradient is DATA, not a design token, so it is passed as the --gp-swatch custom
  property exactly like ColorField passes its swatch color as --cf-swatch.

  `data-ramp-stops` states the preset's REAL stop count. It needs its own home
  because --gp-swatch no longer implies it: for a looping or OKLab ramp the swatch
  is a RESAMPLE of the colours the ramp will produce (cssRampSwatch), not its
  authored stops, so counting the CSS stops would report the sample count instead
  of the ramp's. Anything that needs to know how long the list it is about to apply
  is — a probe measuring list churn, a future "12 stops" hint — reads this.

  Props: onpick(ramp) — called with a fresh {stops, loop, space} ramp when a preset
  is chosen; onpreview(ramp) — the same ramp, staged as a live preview while a
  swatch is hovered; oncancelpreview() — revert that preview; families — the
  declared libraries to list (defaults to every ramp family);
  onopenchange(open) — reports the library opening/closing, so the mount point can
  react to it being open at all (PaintField folds the sibling stop list while it
  is: hovering a swatch rewrites every stop, and a list re-rendering under the
  cursor is the flicker the fold exists to stop); disabled — greys out the toggle.
  The optional callbacks are guarded at the call site, following the sibling
  AngleField's onpreview/oncommit convention.
-->
<script module>
  import { DEFAULT_RAMP_SPACE, sampleRampHex } from "../core/ramps.js";

  const PERCENT = 100; // stop offsets are 0..1; CSS gradient stops are 0..100%

  /**
   * Pure function. A CSS linear-gradient() preview string for a stop list, with
   * each stop's ABSOLUTE offset (0..1) mapped to a percentage.
   *
   * @param {{offset:number,color:string}[]} stops - ordered stops, offsets in [0,1]
   * @returns {string} a CSS `linear-gradient(...)` value
   *
   * @example cssGradientFromStops([{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]) // "linear-gradient(90deg, #000000 0%, #ffffff 100%)"
   * @example cssGradientFromStops([{offset:0,color:"#833ab4"},{offset:0.5,color:"#fd1d1d"},{offset:1,color:"#fcb045"}]) // "linear-gradient(90deg, #833ab4 0%, #fd1d1d 50%, #fcb045 100%)"
   */
  export function cssGradientFromStops(stops) {
    const parts = stops.map((s) => `${s.color} ${+(s.offset * PERCENT).toFixed(2)}%`);
    return `linear-gradient(90deg, ${parts.join(", ")})`;
  }

  /**
   * How many points a RESAMPLED swatch is drawn from. 32 is the size of the
   * palette table the widest consumer of a cyclic ramp actually renders from
   * (render_gpu/skia/mandelbrot_shader.js MANDELBROT_PALETTE_STOPS), so a swatch
   * promises exactly the smoothness the render delivers and no more — a linked
   * constant, not a taste call. Not imported from there because this control is
   * not that widget's; if the table size ever moves, this follows it.
   */
  const SWATCH_SAMPLES = 32;

  /**
   * Pure function. The CSS gradient a swatch shows for a whole RAMP — which is not
   * always its stop list. A ramp whose declared reading is sRGB-and-clamped IS its
   * stop list, so the 343 baked gradients render byte-identically to before. A ramp
   * that LOOPS or blends in OKLab is not expressible as CSS stops at all, so it is
   * RESAMPLED through the real sampler (core/ramps.js) and shown as the colours it
   * will actually produce.
   *
   * WHY THIS MATTERS RATHER THAN BEING A NICETY: a swatch IS hover feedback, and
   * hover feedback that misrepresents what a click will apply is the defect the
   * manifest's hover doctrine exists to stop. Drawn from its raw stops, an OKLab
   * cyclic palette's swatch would show the sRGB blend the render does NOT use, and
   * would hide the wrap segment entirely.
   *
   * @param {{stops:{offset:number,color:string}[],loop:boolean,space:string}} ramp
   * @returns {string} a CSS `linear-gradient(...)` value
   *
   * @example cssRampSwatch({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}], loop:false, space:"srgb"})
   * // "linear-gradient(90deg, #000000 0%, #ffffff 100%)"   (its stops, verbatim)
   * @example cssRampSwatch({stops:[{offset:0,color:"#000000"},{offset:0.5,color:"#ffffff"}], loop:true, space:"srgb"})
   * // a 33-stop resample showing the black→white ramp AND the synthesised white→black wrap
   */
  export function cssRampSwatch(ramp) {
    if (!ramp.loop && ramp.space === DEFAULT_RAMP_SPACE) return cssGradientFromStops(ramp.stops);
    const sampled = Array.from({ length: SWATCH_SAMPLES + 1 }, (_, i) => ({
      offset: i / SWATCH_SAMPLES,
      color: sampleRampHex(ramp.stops, i / SWATCH_SAMPLES, ramp),
    }));
    return cssGradientFromStops(sampled);
  }

</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { RAMP_PRESET_FAMILIES, filterRampFamilies } from "./ramp_preset_families.js";

  let {
    onpick, onpreview = null, oncancelpreview = null, onopenchange = null,
    families = RAMP_PRESET_FAMILIES, disabled = false,
  } = $props();

  let open = $state(false);
  let query = $state("");
  let searchEl = $state(null);
  let bodyEl = $state(null);

  let filtered = $derived(filterRampFamilies(families, query));

  /**
   * Pure function. A FRESH copy of a preset RECORD — a new stop array, never the
   * shared preset object, so neither the document nor a preview can alias
   * author-time data. The ramp ASPECTS travel with it, which is what makes a
   * cyclic OKLab palette land cyclic and perceptual wherever it is applied.
   *
   * @param {{name:string, stops:{offset:number,color:string}[], loop:boolean, space:string}} preset
   * @returns {{stops:{offset:number,color:string}[], loop:boolean, space:string}}
   *
   * @example freshRamp({name:"x", stops:[{offset:0,color:"#000000"}], loop:true, space:"oklab"})
   * // {stops: [{offset: 0, color: "#000000"}], loop: true, space: "oklab"}
   */
  function freshRamp(preset) {
    return { stops: preset.stops.map((s) => ({ offset: s.offset, color: s.color })), loop: preset.loop, space: preset.space };
  }

  /** Command. Reverts the hover preview (the mount point restores what the
   * document actually holds). Safe to call when nothing is staged. */
  function cancelPreview() {
    if (oncancelpreview) oncancelpreview();
  }

  /** Command. Sets the open state and REPORTS it (onopenchange) — the one place
   * `open` is written, so no path can change it without the mount point hearing
   * about it. */
  function setOpen(next) {
    open = next;
    if (onopenchange) onopenchange(next);
  }

  /** Command. Collapses the library, clears the search, and reverts any hover
   * preview — the grid can unmount with the pointer still over a swatch, which
   * fires no pointerleave, so the revert must not depend on one. */
  function close() {
    setOpen(false);
    query = "";
    cancelPreview();
  }

  /** Command. Toggles the library open/closed; a fresh open starts unfiltered. */
  function toggle() {
    if (disabled) return;
    if (open) close();
    else setOpen(true);
  }

  /** Command. Live-previews `preset` on the selected item WITHOUT committing:
   * the mount point stages the stops into app.previewDelta, so the viewport
   * renders them while the document stays untouched and no undo entry is
   * created. The next hover overwrites it; leaving the grid reverts it. */
  function preview(preset) {
    if (disabled || !onpreview) return;
    onpreview(freshRamp(preset));
  }

  /** Command. Applies a preset durably (one undo unit, via onpick) and collapses
   * the library. The commit consumes the staged preview, so close()'s revert is
   * a no-op here — it only guards the unmount-without-pointerleave case. */
  function pick(preset) {
    onpick(freshRamp(preset));
    close();
  }

  /** Escape closes the library (mirrors ColorField's inline picker); stops
   * propagation so it doesn't also bubble into Deselect. */
  function onKeydown(e) {
    if (e.key === "Escape" && open) {
      close();
      e.stopPropagation();
    }
  }

  // On open: focus the search field so typing filters at once, and scroll the
  // revealed body into view. The Inspector pane SCROLLS, and this field sits far
  // down a long property list, so a library opened near the fold would otherwise
  // have its bottom rows cut off by the pane edge. `block: "nearest"` scrolls the
  // minimum needed (the EquationSuggest / CommandPalette scrollIntoView idiom).
  $effect(() => {
    if (!open || !searchEl || !bodyEl) return;
    searchEl.focus();
    bodyEl.scrollIntoView({ block: "nearest" });
  });

  // THIS WHOLE FIELD can unmount while the library is open (the paint switches to
  // Solid), and that fires no close() — so report closed on teardown, for exactly
  // the reason close() reverts a preview no pointerleave will ever revert. Without
  // it a mount point that folded a list while the library was open would be left
  // holding it folded by a picker that no longer exists.
  $effect(() => () => {
    if (open && onopenchange) onopenchange(false);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gradient-presets" onkeydown={onKeydown}>
  <button
    type="button"
    class="gradient-presets-toggle"
    {disabled}
    aria-expanded={open}
    onclick={toggle}
  >
    <iconify-icon icon="mdi:gradient-horizontal" width="14" height="14"></iconify-icon>
    <span>Preset library</span>
    <iconify-icon class="gradient-presets-caret" icon="mdi:menu-down" width="14" height="14"></iconify-icon>
  </button>

  {#if open}
    <div class="gradient-presets-body" bind:this={bodyEl}>
      <input
        class="gradient-presets-search"
        type="text"
        placeholder="Search presets…"
        aria-label="Search gradient presets"
        bind:this={searchEl}
        bind:value={query}
      />
      <!-- pointerleave on the GRID (not each swatch) reverts only when the
           pointer leaves the tiles entirely; moving BETWEEN swatches fires each
           one's pointerenter, overwriting the preview without a revert between
           them (the ToolsPane preset card-grid precedent). -->
      <div
        class="gradient-presets-grid"
        role="listbox"
        aria-label="Gradient presets"
        tabindex="-1"
        onpointerleave={cancelPreview}
      >
        {#each filtered as family (family.id)}
          <!-- The family CAPTION spans the whole grid row (app.css
               .gradient-presets-family), so a family reads as a group rather than
               as an unexplained change of colour halfway down the tiles. -->
          <div class="gradient-presets-family">{family.title}</div>
          {#each family.presets as p (p.name)}
            <Tooltip text={p.name}>
              <button
                type="button"
                class="gradient-swatch"
                role="option"
                aria-selected="false"
                aria-label={p.name}
                data-ramp-stops={p.stops.length}
                style:--gp-swatch={cssRampSwatch(p)}
                onpointerenter={() => preview(p)}
                onclick={() => pick(p)}
              ></button>
            </Tooltip>
          {/each}
        {:else}
          <div class="gradient-presets-empty">No presets match</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
