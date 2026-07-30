<!--
  StaticModeNotice — the VISIBLE statement that this page has no backend.

  The user ruling behind it: a statically hosted build must "LOUDLY mark
  server-only features (render jobs) as unavailable — a visible notice, not a
  404". So when the app is running on browser-local storage (GitHub Pages, a
  `vite preview`, or ?static=1), a dismissible strip below the toolbar says so,
  names what is missing, and says what to use instead.

  SHAPE (user ruling 2026-07-30): a small TOP-LEFT CHIP by default — never an
  unsolicited banner. Clicking the chip expands the full explainer strip;
  X collapses back to the chip. Static mode is a WORKING mode, not an error —
  the chip states it at a glance, the strip is on demand.

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

  // COLLAPSED BY DEFAULT (user ruling: "that giant banner could really just be
  // something on the top left… not a banner that takes up a sizable chunk of my
  // screen at all times"). The chip is the resting state; the full explainer
  // strip appears only when the chip is clicked, and X returns to the chip.
  let expanded = $state(false);

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
  {#if !expanded}
    <!-- The RESTING state: a small top-left chip, zero canvas real estate
         beyond itself. Which storage a session uses stays answerable at a
         glance (it decides whether closing the tab risks the work); the full
         explainer is one click away. -->
    <Tooltip text={detail()}>
      <button class="static-badge" onclick={() => (expanded = true)} aria-label="Storage: browser-local (no server). Show details">
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
      <Tooltip text="Collapse back to the corner chip">
        <button class="btn-icon" aria-label="Collapse notice" onclick={() => (expanded = false)}>
          <iconify-icon icon="mdi:close" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
    </div>
  {/if}
{/if}
