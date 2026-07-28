<!--
  BrushPalette — a THUMBNAIL GRID for the texture brush (manifest C.7). It shows
  the 23 real brush-stroke textures (render_gpu/skia/brush_textures/) as little
  swatches over a transparency checkerboard, grouped by an optional CATEGORY
  filter (watercolour / oil / ink / …), and EMITS a selection. It is the demo's
  sidebar (rp/misc/skia_trail_interactive_paint_demo.py) as a Svelte component.

  DELIBERATELY NOT WIRED INTO PaintField: a sibling agent owns PaintField, and the
  integrator mounts this in wave 2 (above the texture-brush knob rows, the way
  GradientPresetPicker mounts above a ramp's stop list). This component is
  self-contained and owns no document write — it hands the chosen texture id to
  its callbacks and lets the mount point stage/commit it.

  HOVER PREVIEW (the FontPicker / GradientPresetPicker trope): pointerenter a
  swatch previews that texture live via onpreview(id); leaving the GRID (not each
  swatch — moving between neighbours must not flicker a revert) cancels it via
  oncancelpreview(). Clicking commits via onpick(id).

  No <style> block (web/ app convention): classes live in app.css
  (.brush-palette / .brush-swatch / … via --a-* tokens; a clearly-marked block was
  appended at the END of app.css). Each swatch's texture URL is DATA, passed as the
  --bp-swatch custom property exactly like ColorField passes --cf-swatch.

  Props:
    value — the currently selected texture id (highlighted); null for none.
    onpick(id) — called with a texture id when a swatch is clicked (commit).
    onpreview(id) — the same id, staged as a live preview while a swatch is hovered.
    oncancelpreview() — revert that preview (pointer left the grid).
  The optional callbacks are guarded at the call site (AngleField convention).
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { BRUSH_TEXTURES, textureUrl } from "../render_gpu/skia/brush_textures/manifest.js";

  let { value = null, onpick, onpreview = null, oncancelpreview = null } = $props();

  // The category filter chips: "all" plus each distinct category in palette order.
  const CATEGORIES = ["all", ...Array.from(new Set(BRUSH_TEXTURES.map((t) => t.category)))];
  let category = $state("all");

  let shown = $derived(category === "all" ? BRUSH_TEXTURES : BRUSH_TEXTURES.filter((t) => t.category === category));

  /** Command. Live-previews texture `id` without committing (guarded — a mount
   * point may not pass onpreview). */
  function preview(id) {
    if (onpreview) onpreview(id);
  }

  /** Command. Reverts the hover preview when the pointer leaves the whole grid.
   * Safe to call when nothing is staged. */
  function cancelPreview() {
    if (oncancelpreview) oncancelpreview();
  }

  /** Command. Commits texture `id` as the selection (one undo unit, via onpick). */
  function pick(id) {
    onpick(id);
  }
</script>

<div class="brush-palette">
  <div class="brush-palette-cats" role="tablist" aria-label="Texture category">
    {#each CATEGORIES as cat (cat)}
      <button
        type="button"
        class="brush-cat-chip"
        class:brush-cat-chip-active={category === cat}
        role="tab"
        aria-selected={category === cat}
        onclick={() => (category = cat)}
      >{cat}</button>
    {/each}
  </div>

  <!-- pointerleave on the GRID (not each swatch) reverts only when the pointer
       leaves the tiles entirely; moving BETWEEN swatches fires each one's
       pointerenter, overwriting the preview without a revert between them. -->
  <div
    class="brush-palette-grid"
    role="listbox"
    aria-label="Brush textures"
    tabindex="-1"
    onpointerleave={cancelPreview}
  >
    {#each shown as t (t.id)}
      <Tooltip text={t.name}>
        <button
          type="button"
          class="brush-swatch"
          class:brush-swatch-selected={value === t.id}
          role="option"
          aria-selected={value === t.id}
          aria-label={t.name}
          style:--bp-swatch={`url("${textureUrl(t.id)}")`}
          onpointerenter={() => preview(t.id)}
          onclick={() => pick(t.id)}
        ></button>
      </Tooltip>
    {/each}
  </div>
</div>
