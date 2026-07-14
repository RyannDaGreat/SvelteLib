<!--
  Panel — THE first-class panel (manifest ruling: panels own their region name,
  optional title bar, chrome, and hover context — by construction, not by
  per-component discipline).

  - `name` is the canonical region name from the manifest's UI-regions glossary.
  - Title bar renders when app.panelNames is on (palette: Toggle Panel Names).
  - Pointer presence sets app.hoverRegion = name — the substrate that lets the
    Hint Bar (and future lib-component hints) know which region the mouse is in.
  - Chrome: panel background + scrolling body live HERE; children are content.
  Styling lives in app.css (.panel / .panel-title / .panel-body).
-->
<script>
  let { app, name, children } = $props();

  function enter() {
    app.hoverRegion = name;
  }
  function leave() {
    if (app.hoverRegion === name) app.hoverRegion = null;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="panel" data-region={name} onpointerenter={enter} onpointerleave={leave}>
  {#if app.panelNames}
    <div class="panel-title">{name}</div>
  {/if}
  <div class="panel-body">
    {@render children()}
  </div>
</section>
