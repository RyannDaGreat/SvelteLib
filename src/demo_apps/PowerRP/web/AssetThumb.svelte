<!--
  AssetThumb — the MEDIA layer of an asset tile (manifest #25): the generalized
  {thumbnail?, badge?} renderer shared by the Asset Explorer grid AND the
  AssetField picker, so "how an asset previews" lives in ONE place.

  Per the pure decision in assetThumbnail.js (assetTilePresentation):
    - image  → a real <img> thumbnail (SvelteLib Thumbnail, cover-fit).
    - video  → a client-captured frame (VideoThumbnail).
    - pdf    → a cached first-page thumbnail bitmap + a PAGE-COUNT badge. If the
               server has one cached it shows instantly; otherwise this rasterizes
               page 1 client-side (app.ensureAssetThumbnail) ONCE, shows it, and
               persists it. Async + LOUD on failure (console.error + a visible
               error glyph) — never a silently-blank tile, never blocks the list.
    - other  → the kind glyph (sound/font/…), plus any generic badge.

  Renders ONLY the tile's inner media + the corner badge — the parent owns the
  .ae-tile box + its hover buttons. Styling is in app.css (.ae-*; NO <style>).
-->
<script>
  import "iconify-icon";
  import Thumbnail from "../../../lib/Thumbnail.svelte";
  import VideoThumbnail from "./VideoThumbnail.svelte";
  import { assetUrl } from "./projectApi.js";
  import { assetTilePresentation } from "./assetThumbnail.js";

  // app — the controller (for ensureAssetThumbnail); asset — {name,kind,url,mtime,thumbnail?,badge?};
  // onclick — tile click (the field's pick; a no-op in the Explorer, which owns dblclick separately).
  let { app, asset, onclick = () => {} } = $props();

  let pres = $derived(assetTilePresentation(asset));

  // Client-rendered {thumbnail, badge} for a PDF with no server-cached thumb.
  let rendered = $state(null);
  let failed = $state(null);
  // Guard so the rasterize+store command fires ONCE per (url, mtime), not every
  // reactive re-run — a fresh mtime (replaced file) legitimately re-renders.
  let requestedKey = null;
  $effect(() => {
    if (!pres.needsClientThumbnail) return;
    const key = `${asset.url}|${asset.mtime}`;
    if (key === requestedKey) return;
    requestedKey = key;
    rendered = null;
    failed = null;
    app.ensureAssetThumbnail(asset).then(
      (r) => (rendered = r),
      (e) => {
        failed = e?.message ?? String(e);
        console.error(`AssetThumb: thumbnail render failed for "${asset.name}":`, e);
      },
    );
  });

  // The bitmap URL actually shown: a server-cached thumbnail (already absolute
  // via the /asset seam) or the freshly client-rendered data URL.
  let imgSrc = $derived(pres.mode === "thumbnail" ? assetUrl(pres.src) : rendered?.thumbnail ?? null);
  // Badge: the freshly-rendered page count wins over the server-cached one.
  let badge = $derived(rendered?.badge ?? pres.badge);
</script>

{#if pres.mode === "image"}
  <Thumbnail src={assetUrl(pres.src)} title="" {onclick} />
{:else if pres.mode === "video"}
  <VideoThumbnail src={assetUrl(pres.src)} {onclick} />
{:else if imgSrc}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <img class="ae-thumb-img" src={imgSrc} alt="" loading="lazy" {onclick} onkeydown={(e) => e.key === "Enter" && onclick(e)} />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ae-kind" role="button" tabindex="0" {onclick} onkeydown={(e) => e.key === "Enter" && onclick(e)}>
    {#if failed}
      <iconify-icon icon="mdi:alert-circle-outline" width="28" height="28" title={failed}></iconify-icon>
    {:else}
      <iconify-icon icon={pres.icon} width="28" height="28"></iconify-icon>
    {/if}
  </div>
{/if}

{#if badge}
  <div class="ae-badge" aria-hidden="true">
    {#if pres.badgeIcon}<iconify-icon icon={pres.badgeIcon} width="11" height="11"></iconify-icon>{/if}
    <span class="ae-badge-text">{badge}</span>
  </div>
{/if}
