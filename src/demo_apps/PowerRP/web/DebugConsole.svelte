<!--
  DebugConsole — THE debug submenu's shell (user ruling: "it's a big modal — we
  might have other debug things in the future, so prepare the organization
  scheme"). A LARGE modal (src/lib/Modal.svelte size="large") with a slim left
  nav listing DEBUG PAGES, and one page mounted at a time on the right.

  ── THE ONE GROWTH POINT ──────────────────────────────────────────────────────
  DEBUG_PAGES below is a declarative table: {id, title, icon, component}. A
  future debug tool is ONE ROW in that table plus its own page component —
  nothing else changes here, in the palette wiring (App.svelte's "debug"
  submenu, generated FROM this table), or in this file's markup. Do not add a
  second switch/if-chain anywhere for "which debug page is this" — DEBUG_PAGES
  is the only place that question is answered.

  Precedent: PLUGIN_WIDGETS_SUBMENU (plugins/builtin_asset_commands.js) is the
  house pattern for a stable submenu whose children are GENERATED from a table
  rather than hand-registered one by one — same idea, applied to a nav list
  instead of palette children.

  ── LAST-VIEWED PAGE IS A VIEWER PREFERENCE ──────────────────────────────────
  Which page is showing persists across sessions (localStorage, the settings.js
  convention used elsewhere in this app for per-browser viewer preferences —
  e.g. the "Show built-in assets" toggle). core/commands.js enforces `run` XOR
  `children`, so the palette's "Debug" row (like every other container-with-
  children in this app — Color Theme's family rows, the Plugin Widget submenu)
  is a pure container and cannot itself run an action; its FIRST child, "Debug
  Console", is what opens with no `initialPage` and so resumes wherever the
  user left off, rather than always resetting to Storage. Every other child
  names a specific page and jumps straight to it.
-->
<script module>
  import DebugStoragePage from "./DebugStoragePage.svelte";
  import { resolveInitialPage } from "./debugStorage.js";

  /**
   * THE DEBUG_PAGES TABLE — the one growth point (see file header). Each entry:
   *   id         stable string, used for the palette child id, the nav row key,
   *              and the last-viewed persistence — never renamed once shipped
   *              (renaming would silently reset every user's last-viewed page).
   *   title      nav row label + palette child title suffix.
   *   icon       iconify glyph name, nav row + palette child.
   *   component  the Svelte component mounted on the right when this page is
   *              active. Takes one prop, `app` (the live PowerRPApp), exactly
   *              like every other modal page in this codebase.
   *
   * Storage is FIRST (the user's concrete ask); later tools append here.
   */
  export const DEBUG_PAGES = Object.freeze([
    { id: "storage", title: "Storage", icon: "mdi:database-outline", component: DebugStoragePage },
  ]);

  /** localStorage key for the last-viewed debug page id — read by both this
   *  component (to resume) and App.svelte's bare "Debug" palette entry (to
   *  open the console at that page without drilling into a specific child). */
  export const LAST_DEBUG_PAGE_KEY = "powerrp.debugConsole.lastPage";
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let {
    /** @type {object} the live PowerRPApp — forwarded to every page component. */
    app,
    /** @type {string} which page to open on. Undefined = resume the
     *  last-viewed page (the bare "Debug" palette parent's behavior); a
     *  specific value (a per-page palette child) jumps straight there. */
    initialPage = undefined,
  } = $props();

  let activePage = $state(resolveInitialPage(initialPage ?? localStorage.getItem(LAST_DEBUG_PAGE_KEY), DEBUG_PAGES));

  // App.svelte remounts this component fresh on every open ({#if
  // debugConsoleVisible}), so the $state initializer above already captures
  // the right page for the common case. This effect exists for the less
  // common one: `initialPage` changing WHILE the console stays mounted (e.g.
  // a future host that keeps it alive and re-dispatches a page-specific
  // command) — without it, only the FIRST open's initialPage would ever take
  // effect, silently stranding the console on whatever page was showing.
  $effect(() => {
    if (initialPage !== undefined) selectPage(initialPage);
  });

  function selectPage(id) {
    activePage = id;
    localStorage.setItem(LAST_DEBUG_PAGE_KEY, id);
  }

  let activeEntry = $derived(DEBUG_PAGES.find((p) => p.id === activePage) ?? DEBUG_PAGES[0]);
  // A dynamic Svelte component TAG must be a plain capitalized identifier, not
  // a member expression (`<activeEntry.component>` is not valid Svelte
  // markup) — so the table's `component` field is rebound to this local on
  // every page switch.
  let ActivePageComponent = $derived(activeEntry.component);
</script>

<div class="debug-console">
  <nav class="debug-nav" aria-label="Debug pages">
    {#each DEBUG_PAGES as page (page.id)}
      <Tooltip text={page.title}>
        <button
          type="button"
          class="debug-nav-item"
          class:is-active={page.id === activePage}
          aria-current={page.id === activePage ? "page" : undefined}
          onclick={() => selectPage(page.id)}
        >
          <iconify-icon icon={page.icon} width="18" height="18"></iconify-icon>
          <span class="debug-nav-label">{page.title}</span>
        </button>
      </Tooltip>
    {/each}
  </nav>
  <div class="debug-page">
    <ActivePageComponent {app} />
  </div>
</div>
