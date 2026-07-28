<!--
  SearchableDropdown [visual, general] — a Dropdown with a TYPE-TO-FILTER box.

  Layout when open: the trigger on top, a search input directly beneath it, then
  the (filtered, ranked) options. It is NOT a fork of Dropdown — it COMPOSES it
  through two additive seams Dropdown exposes: the `header` snippet (the search
  box) and `listItems` (the filtered/ranked subset the menu renders, while the
  full `items` still resolves the trigger label + value). So there is exactly ONE
  menu implementation, one keyboard model, one hover-preview contract, one
  no-clip floating menu — all inherited.

  MATCHING IS PLUGGABLE. The default is plain fuzzy subsequence matching
  (./fuzzyMatch.js: `rankItems`, which merges matching + sorting into one pure
  function). Pass `rankFn(query, items) -> items[]` to replace BOTH the matcher
  and the sort at once — return the surviving items best-first, and attach a
  `_spans` array of [start,end) label ranges on each for highlighting. To keep
  the default ranking but swap only the per-candidate scorer, wrap rankItems with
  its `matchFn`/`textOf` options. See fuzzyMatch.js's "PLUGGABILITY CONTRACT".

  HIGHLIGHTING: each option's matched characters render in <mark class="sd-mark">
  (bold, accent-tinted) — from the `_spans` the ranker attached, split by
  segmentSpans. A caller passing its own `item` snippet opts out of the built-in
  highlight and renders rows however it likes.

  SMALL LISTS STAY PLAIN: the search box only appears when the selectable option
  count EXCEEDS `minItemsForSearch` (default 8 — short enums "stay"). Below that,
  no header renders and this is byte-for-byte a Dropdown.

  Keyboard: typing filters; ↑/↓ navigate the FILTERED list, Enter picks, Home/End
  edit the search text; Esc CLEARS a non-empty query first, then (empty) closes —
  the standard clear-then-close. All of it except the Esc-clear is Dropdown's own
  handling, reached by letting keys bubble from the search box.

  Preview: `onpreview(value)` / `oncancelpreview()` fire for the active row exactly
  as in Dropdown — filtered rows preview identically (PowerRP's material picker
  depends on this).

  Props mirror Dropdown's single-select subset, plus: `rankFn`, `searchPlaceholder`,
  `minItemsForSearch`. `open` is bindable (forwarded to Dropdown).
-->
<script module>
  import { rankItems, segmentSpans } from "./fuzzyMatch.js";
</script>

<script>
  import Dropdown from "./Dropdown.svelte";

  let {
    /** @type {({value:any,label:string,disabled?:boolean}|{insert:any})[]} */
    items = [],
    /** @type {any} single-select value ($bindable) */
    value = $bindable(undefined),
    placeholder = "Select…",
    /** @type {(value:any)=>void} */
    onchange = undefined,
    /** @type {(value:any)=>void} preview the active row (never a commit) */
    onpreview = undefined,
    /** @type {()=>void} revert the live preview */
    oncancelpreview = undefined,
    /** @type {any} scroll this value's row into view on open */
    scrollToValue = undefined,
    /** @type {(query:string, items:any[])=>any[]} pluggable matcher+sorter;
     *  returns surviving items best-first, each with `_spans` for highlighting.
     *  Default: rankItems (plain fuzzy). See fuzzyMatch.js. */
    rankFn = rankItems,
    searchPlaceholder = "Search…",
    /** @type {number} show the search box only when the selectable option count
     *  exceeds this (small enums stay plain). */
    minItemsForSearch = 8,
    /** @type {boolean} $bindable open state, forwarded to Dropdown */
    open = $bindable(false),
    /** @type {import('svelte').Snippet=} override the trigger rendering */
    trigger,
    /** @type {import('svelte').Snippet=} override per-row rendering (opts out of
     *  the built-in match highlight) */
    item: itemSnippet,
  } = $props();

  let query = $state("");
  let searchEl = $state(null);

  /* Selectable (non-insert) option count decides whether the box shows at all. */
  const selectableCount = $derived(
    items.filter((it) => it != null && !Object.prototype.hasOwnProperty.call(it, "insert")).length);
  const showSearch = $derived(selectableCount > minItemsForSearch);
  /* The rendered/navigated rows: ranked when filtering, the full list otherwise. */
  const ranked = $derived(query.trim() ? rankFn(query.trim(), items) : items);

  /* Focus the search box the instant the menu opens, so typing filters at once.
     preventScroll: the box lives in a fixed-position menu, so the browser must
     NOT scroll an ancestor to "reveal" it — that spurious scroll would move the
     anchor and trip Dropdown's close-on-outside-scroll (measured: the Inspector
     panel-body scrolled and closed the picker mid-hover). */
  $effect(() => {
    if (open && showSearch && searchEl) searchEl.focus({ preventScroll: true });
  });
  /* Clear the query whenever the menu closes — the next open starts unfiltered.
     Reads `open` only (not `query`), so writing query does not re-run it. */
  $effect(() => {
    if (!open) query = "";
  });

  /**
   * Command. The search box's own keydown, BEFORE it bubbles to Dropdown:
   *   - Escape with a non-empty query → clear it and STOP (a second, empty-query
   *     Escape then bubbles to Dropdown and closes) — clear-then-close.
   *   - Home/End → keep them for editing the search text (stop the bubble so
   *     Dropdown doesn't hijack them to jump the list).
   *   - everything else (↑/↓, Enter, typing) bubbles to Dropdown untouched.
   */
  function onSearchKeydown(e) {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      query = "";
      return;
    }
    if (e.key === "Home" || e.key === "End") e.stopPropagation();
  }
</script>

<Dropdown
  {items}
  bind:value
  bind:open
  {placeholder}
  {onchange}
  {onpreview}
  {oncancelpreview}
  {scrollToValue}
  {trigger}
  listItems={ranked}
  header={showSearch ? searchBox : undefined}
  item={itemSnippet ?? highlight}
/>

{#snippet searchBox()}
  <input
    class="sd-search"
    type="text"
    placeholder={searchPlaceholder}
    aria-label={searchPlaceholder}
    bind:this={searchEl}
    bind:value={query}
    onkeydown={onSearchKeydown}
  />
{/snippet}

{#snippet highlight(it, _active)}
  {#if it && it._spans}
    {#each segmentSpans(it.label, it._spans) as seg}
      {#if seg.match}<mark class="sd-mark">{seg.text}</mark>{:else}{seg.text}{/if}
    {/each}
  {:else}
    {it?.label}
  {/if}
{/snippet}

<style>
  /* The search field fills the header (Dropdown pads the .dd-header around it).
     Chains to Dropdown's own --dd-* tokens so it follows the same theme, with a
     standalone literal fallback — the house pattern for lib components. */
  /* NO box around the search (user ruling — "just a slightly different color");
     the in-app precedent is the COMMAND PALETTE's input: borderless, set apart
     by a background tint and a bottom hairline. A subtle brightening on the
     dropdown bg does the "different color"; focus brightens the hairline
     instead of drawing a ring. */
  .sd-search {
    box-sizing: border-box;
    width: 100%;
    background: color-mix(in srgb, var(--dd-fg, #e0e0e0) 7%, var(--dd-bg, rgba(20, 20, 30, 0.92)));
    color: var(--dd-fg, #e0e0e0);
    border: 0;
    border-bottom: 1px solid var(--dd-border, rgba(255, 255, 255, 0.18));
    border-radius: 0;
    padding: var(--dd-padding, 4px 10px);
    font: inherit;
    font-size: var(--dd-font-size, 0.85rem);
  }
  .sd-search::placeholder {
    color: var(--dd-fg-dim, #888);
  }
  .sd-search:focus {
    outline: none;
    border-bottom-color: var(--dd-active-bg, #7aa2f7);
  }

  /* Matched characters: bold + accent-tinted, no boxy background that would
     fight the row's own hover/selected fills — an underline-free emphasis. */
  .sd-mark {
    background: transparent;
    color: var(--dd-active-fg, #e0e0e0);
    font-weight: 700;
    /* A faint accent wash so a match reads even without the weight change. */
    box-shadow: inset 0 -0.5em 0 color-mix(in srgb, var(--dd-active-bg, #7aa2f7) 35%, transparent);
  }
</style>
