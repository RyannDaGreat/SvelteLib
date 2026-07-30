<!--
  StaticModeNotice — the VISIBLE statement that this page has no backend.

  The user ruling behind it: a statically hosted build must "LOUDLY mark
  server-only features (render jobs) as unavailable — a visible notice, not a
  404". So when the app is running on browser-local storage (GitHub Pages, a
  `vite preview`, or ?static=1), a dismissible strip below the toolbar says so,
  names what is missing, and says what to use instead.

  WHY A STRIP AND NOT A MODAL: static mode is a WORKING mode, not an error. A
  modal would demand acknowledgement before letting someone draw, which
  overstates it — most of the app is fully functional here. A strip states the
  bound once, stays available behind an always-visible badge after dismissal, and
  never blocks the canvas.

  WHY IT IS NOT SILENT: without it, a user clicking Render would get a fetch
  error against a URL that was never going to exist, and would reasonably
  conclude the app is broken rather than that this deployment has no server. The
  distinction between "broken" and "bounded" is the entire content of this
  component.

  Renders NOTHING in server mode (app.isStatic() false).

  Chrome per house rules: no <style> block — every class is in app.css via --a-*
  tokens; iconify glyphs only; square corners; SvelteLib Tooltip for hover help.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { UNAVAILABLE_IN_STATIC } from "./storageMode.js";

  let { app } = $props();

  // Dismissed for THIS page load only (deliberately not persisted): a reload is
  // a fresh session, and someone returning to a deck a week later should be told
  // again where its bytes live before they trust the browser with more work.
  let dismissed = $state(false);

  /** The server-only features, as [name, reason] rows for the detail list. ONE
   *  source (storageMode.js UNAVAILABLE_IN_STATIC) so a feature can never be
   *  refused by the code and unlisted by the UI. */
  const unavailable = Object.entries(UNAVAILABLE_IN_STATIC);

  /** Query. The badge/strip hover detail: every server-only bound, one per line.
   *  Long by design — this is the reference answer to "what can't I do here?",
   *  and it is in a tooltip precisely so it costs nothing until asked for. */
  function detail() {
    return [`${app.storageModeReason()}.`, "", "Not available without a project server:", ...unavailable.map(([, why]) => `• ${why}`)].join("\n");
  }
</script>

{#if app.isStatic()}
  {#if dismissed}
    <!-- After dismissal the notice collapses to a PERSISTENT badge, never to
         nothing: which storage a session is using must stay answerable at a
         glance, since it decides whether closing the tab risks the work. -->
    <Tooltip text={detail()}>
      <button class="static-badge" onclick={() => (dismissed = false)} aria-label="Storage: browser-local (no server). Show details">
        <iconify-icon icon="mdi:database-outline" width="14" height="14"></iconify-icon>
        <span>Local storage</span>
      </button>
    </Tooltip>
  {:else}
    <div class="static-notice" role="status">
      <iconify-icon class="static-notice-icon" icon="mdi:cloud-off-outline" width="18" height="18"></iconify-icon>
      <div class="static-notice-body">
        <div class="static-notice-title">Running without a project server — your work is stored in THIS BROWSER.</div>
        <div class="static-notice-text">
          Projects and assets live in this browser's storage, so they are private to this browser and can be lost if you clear site data.
          <strong>Export a .zip</strong> to keep a durable copy.
          Render jobs and server-side encoding are unavailable here; in-page video export still works.
        </div>
      </div>
      <Tooltip text={detail()}>
        <button class="btn-icon" aria-label="What is unavailable without a server?">
          <iconify-icon icon="mdi:information-outline" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text="Ask the browser to make this site's storage persistent (it may refuse)">
        <button class="btn-icon" aria-label="Request persistent storage" onclick={() => app.requestStoragePersistence()}>
          <iconify-icon icon="mdi:lock-outline" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text="Dismiss (a 'Local storage' badge stays in its place)">
        <button class="btn-icon" aria-label="Dismiss notice" onclick={() => (dismissed = true)}>
          <iconify-icon icon="mdi:close" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
    </div>
  {/if}
{/if}
