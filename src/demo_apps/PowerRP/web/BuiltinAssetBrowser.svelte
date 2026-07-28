<!--
  BuiltinAssetBrowser — a browsable catalog of the app's BUILT-IN assets
  (ship-with-the-app: cursors today), rendered inside a Modal from App.svelte.

  This is a SEPARATE surface from the project Asset Explorer by design: built-ins
  are bundled with the app and identical for every project, so they must NEVER
  appear in the user's per-project asset list (task #68). Widgets still read
  built-ins DIRECTLY (the Cursor widget via svg_raster.js) — this pane only adds
  DISCOVERY: "what ships with the app, and what is each one called".

  UX (mirrors the Asset Explorer's tile grid for consistency — SAME .ae-tile /
  .ae-grid / .ae-cell / .ae-name classes + --a-* tokens, so it reads as one
  system — but is its OWN surface):
    - One SECTION per built-in category (a header with the category icon, name,
      count, and a one-line description). Cursors is the first population.
    - A thumbnail grid of the category's assets (SvelteLib Thumbnail via the
      shared AssetThumb — a cursor is an `image` kind whose url is a self-
      contained SVG data URI, so it previews with no server route).
    - Each tile shows the built-in IDENTIFIER (the name a widget references, e.g.
      "beachball") and copies it to the clipboard on click OR via the hover copy
      button — the Asset Explorer's copy-path affordance, adapted (built-ins have
      no served path; their identifier is the useful thing to grab).
    - A load failure is reported LOUDLY in-pane + to the console (never a
      silently-empty browser).

  Chrome per house rules: NO <style> block (classes in app.css via --a-* tokens),
  square corners, iconify glyphs only, SvelteLib Tooltip for hover help.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import AssetThumb from "./AssetThumb.svelte";
  import { copyText } from "./clipboard.js";
  import { builtinCategories, builtinAssetId } from "./builtinAssets.js";

  // app — passed through to AssetThumb (its ensureAssetThumbnail path is never
  // hit for image-kind built-ins, but the component requires the prop).
  let { app } = $props();

  // How long the copy button flashes "Copied!" after a successful copy — the
  // Asset Explorer's copy-path feedback duration.
  const COPY_FLASH_MS = 1200;
  let justCopied = $state(null); // the identifier currently flashing (null = none)

  // `categories` null = not-yet-loaded; the array once loaded. `error` holds the
  // loud failure message. Loaded once, lazily, on mount (i.e. when the modal
  // opens) — see builtinAssets.js on why the underlying glob pays nothing at boot.
  let categories = $state(null);
  let error = $state(null);
  $effect(() => {
    if (categories !== null || error !== null) return;
    try {
      categories = builtinCategories();
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("BuiltinAssetBrowser: could not load built-in assets:", e);
    }
  });

  /** Command. Copies a built-in asset's IDENTIFIER (the widget-facing name) to
   *  the clipboard, flashing the tile's copy button on success (a genuine
   *  failure is reported loudly inside copyText). */
  async function copyName(a) {
    const id = builtinAssetId(a.name);
    if (await copyText(id, "built-in asset name")) {
      justCopied = id;
      setTimeout(() => { if (justCopied === id) justCopied = null; }, COPY_FLASH_MS);
    }
  }

  /** Pure-ish helper. The singular noun for a category label ("Cursors" →
   *  "cursor") for per-tile tooltips. */
  function singular(label) {
    return label.toLowerCase().replace(/s$/, "");
  }
</script>

<div class="builtin-assets">
  {#if error}
    <div class="ae-notice ae-error">
      <div class="ae-notice-title">Couldn't load built-in assets</div>
      <div class="ae-notice-detail">{error}</div>
    </div>
  {:else if categories === null}
    <div class="ae-notice">Loading…</div>
  {:else}
    {#each categories as cat (cat.id)}
      <section class="ba-section">
        <header class="ba-section-head">
          <iconify-icon icon={cat.icon} width="16" height="16"></iconify-icon>
          <span class="ba-section-title">{cat.label}</span>
          <span class="ba-section-count">{cat.assets.length}</span>
        </header>
        {#if cat.description}
          <p class="ba-section-desc">{cat.description}</p>
        {/if}
        {#if cat.assets.length === 0}
          <div class="ae-notice">No built-in {singular(cat.label)} assets ship with this build.</div>
        {:else}
          <div class="ae-grid">
            {#each cat.assets as a (a.name)}
              {@const id = builtinAssetId(a.name)}
              <div class="ae-cell">
                <!-- The tip names the TILE's own effect: clicking the picture copies
                     the identifier (copyName), which only the corner button's tip
                     used to say — so a click on the picture appeared to do nothing.
                     It also wraps the ellipsized .ae-name label below, which used to
                     sit outside this Tooltip and so could not be read on hover. -->
                <Tooltip text={`${id} — built-in ${singular(cat.label)} · click to copy the name`}>
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="ae-tile">
                    <AssetThumb {app} asset={a} onclick={() => copyName(a)} />
                    <Tooltip text={justCopied === id ? "Copied!" : "Copy name to clipboard"}>
                      <button
                        class="btn-icon ba-copy"
                        aria-label={justCopied === id ? `Copied name ${id}` : `Copy name ${id}`}
                        onclick={() => copyName(a)}
                      >
                        <iconify-icon icon={justCopied === id ? "mdi:check" : "mdi:content-copy"} width="14" height="14"></iconify-icon>
                      </button>
                    </Tooltip>
                  </div>
                  <div class="ae-name">{id}</div>
                </Tooltip>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>
