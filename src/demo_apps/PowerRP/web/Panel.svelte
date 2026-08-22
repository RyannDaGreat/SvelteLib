<!--
  Panel — THE first-class panel (manifest ruling: panels own their region name,
  optional title bar, chrome, and hover context — by construction, not by
  per-component discipline).

  - `name` is the canonical region name from the manifest's UI-regions glossary.
  - Title bar renders when app.panelNames is on (palette: Toggle Panel Names).
  - Pointer presence sets app.hoverRegion = name — the substrate that lets the
    Hint Bar (and future lib-component hints) know which region the mouse is in.
  - Chrome: panel background + scrolling body live HERE; children are content.
  - SCROLL MEMORY lives here too (below), for the same reason the scroller does.
  Styling lives in app.css (.panel / .panel-title / .panel-body).

  ── SCROLL MEMORY (user, 2026-08-21/22) ─────────────────────────────────────
  "the properties need to stop scrolling back to the top each time I deselect and
  reselect a widget" — and, when the fix landed inside the Inspector: "same
  applies to ALL panels including tool panels. It should have been done higher up
  in the class hierarchy."

  THE MECHANISM IS A PROPERTY OF THE SCROLLER, NOT OF ANY CONTENT. `.panel-body`
  is the ONLY scroller (app.css's round-10 ruling), and what resets it is not a
  decision any pane makes: when a pane's content COLLAPSES (the Inspector's rows
  unmount on deselect, the Tools pane drops to "Select a widget…"), the browser
  CLAMPS the scroller's scrollTop to whatever the short content affords — 0 — and
  fires a scroll event for it. When the content comes back it mounts at the top.
  So the remedy belongs at the one place every pane shares:

    REMEMBER  every scroll event records the body's scrollTop, EXCEPT the clamp —
              recognisable because it lands exactly on the new maximum while that
              maximum is below what was remembered. A reader that treated the
              clamp as a user scroll would remember 0 and have nothing to restore.
    RESTORE   a ResizeObserver on the body's content fires when its height changes;
              after any change the remembered position is written back (the
              browser clamps it to what the new content affords). For content
              that grows back after a collapse that is the restore; for a user
              mid-scroll it is a no-op, because the remembered value IS their last
              scroll.

  Session-local view state: it changes nothing that renders, so it is neither
  document state nor a setting. A pane with its own internal scroller (SlideNav)
  never scrolls the body, never records, and is untouched.
-->
<script>
  let { app, name, children } = $props();

  function enter() {
    app.hoverRegion = name;
  }
  function leave() {
    if (app.hoverRegion === name) app.hoverRegion = null;
  }

  let bodyEl = $state(null);
  let remembered = 0;

  /** Query. The furthest the body can currently scroll. */
  const maxScroll = (el) => Math.max(0, el.scrollHeight - el.clientHeight);

  $effect(() => {
    const el = bodyEl;
    if (!el) return;
    const remember = () => {
      // THE CLAMP: content shrank under a remembered position and the browser
      // parked the body at the new (smaller) maximum. Not a user scroll.
      const clamped = el.scrollTop === maxScroll(el) && maxScroll(el) < remembered;
      if (!clamped) remembered = el.scrollTop;
    };
    const restore = () => {
      if (el.scrollTop !== remembered) el.scrollTop = remembered;
    };
    el.addEventListener("scroll", remember, { passive: true });
    // Observe the CONTENT (the body's children), not the body: the body is the
    // fixed-height scroll container, and it is the children whose height changes.
    const ro = new ResizeObserver(restore);
    const observeChildren = () => { for (const child of el.children) ro.observe(child); };
    observeChildren();
    // A pane that swaps its root element (a conditional block at the top level)
    // needs the new child observed too.
    const mo = new MutationObserver(observeChildren);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", remember);
      ro.disconnect();
      mo.disconnect();
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="panel" data-region={name} onpointerenter={enter} onpointerleave={leave}>
  {#if app.panelNames}
    <div class="panel-title">{name}</div>
  {/if}
  <div class="panel-body" bind:this={bodyEl}>
    {@render children()}
  </div>
</section>
