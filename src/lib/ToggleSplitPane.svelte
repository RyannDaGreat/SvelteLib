<!--
  ToggleSplitPane [visual, general] — SplitPane with toggleable panes.

  Wraps SplitPane to support dynamically showing/hiding panes while
  preserving their dragged sizes across toggles. Panes are defined by
  a `panes` array; each entry has a `visible` flag and a default `size`.

  When a pane is toggled off, the remaining panes redistribute. When
  toggled back on, it restores its last-dragged size (or default).

  The last pane is always "content" — it fills whatever space the
  toggled panes don't claim. Content is always visible.

  Usage:
    <ToggleSplitPane orientation="vertical" {panes} minPanePx={50}>
      {#snippet children(paneKey, paneIndex)}
        {#if paneKey === 'sidebar'}
          <Sidebar />
        {:else if paneKey === 'content'}
          <MainContent />
        {/if}
      {/snippet}
    </ToggleSplitPane>

  Props:
    orientation — "horizontal" or "vertical"
    panes — array of { key: string, visible: boolean, size: number (0-1) }
            The last entry is content (always visible, gets remaining space).
    minPaneSize — fractional minimum (default 0.05)
    minPanePx — pixel minimum (overrides minPaneSize)
    children — snippet receiving (paneKey, paneIndex) for each visible pane
-->
<script>
  import SplitPane from './SplitPane.svelte';

  let {
    /** @type {"horizontal"|"vertical"} */
    orientation = 'vertical',
    /**
     * @type {Array<{key: string, visible: boolean, size: number}>}
     * Pane definitions. `size` is the default fractional size (0-1).
     * The last pane is always content and fills remaining space.
     */
    panes = [],
    /** @type {number} Minimum fractional pane size */
    minPaneSize = 0.05,
    /** @type {number|null} Minimum pane size in pixels (overrides minPaneSize) */
    minPanePx = null,
    /** Snippet receiving (paneKey, paneIndex) */
    children: paneContent,
  } = $props();

  /**
   * Pure function, general. Visible pane keys from a pane definitions array.
   *
   * @param {Array<{key: string, visible: boolean}>} panes
   * @returns {string[]}
   *
   * @example visibleKeys([{key:'a', visible:true}, {key:'b', visible:false}]) // ['a']
   */
  function visibleKeys(panes) {
    return panes.filter(p => p.visible).map(p => p.key);
  }

  /**
   * Pure function, general. Build split positions from visible panes and cached sizes.
   *
   * Each visible pane (except the last, which is content) gets a split position.
   * The last pane fills the remaining space (no split after it).
   *
   * @param {string[]} keys - Visible pane keys
   * @param {Array<{key: string, size: number}>} defs - All pane definitions
   * @param {Record<string, number>} cache - Cached sizes from previous drags
   * @returns {number[]} Split positions for SplitPane
   *
   * @example
   * // buildSplits(['a', 'content'], [{key:'a', size:0.3}], {})
   * // => [0.3]  (one split: a ends at 0.3, content fills 0.3-1.0)
   */
  function buildSplits(keys, defs, cache) {
    if (keys.length <= 1) return [];
    const splits = [];
    let pos = 0;
    // All keys except the last get a split position
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      const def = defs.find(p => p.key === key);
      pos += cache[key] ?? def?.size ?? 0.2;
      splits.push(pos);
    }
    return splits;
  }

  /**
   * Pure function, general. Extract per-pane sizes from split positions.
   *
   * @param {string[]} keys - Visible pane keys
   * @param {number[]} splits - Current split positions
   * @returns {Record<string, number>} Map of key → fractional size
   *
   * @example
   * // extractSizes(['a', 'b', 'content'], [0.3, 0.6])
   * // => {a: 0.3, b: 0.3}  (content excluded — it's the remainder)
   */
  function extractSizes(keys, splits) {
    const sizes = {};
    for (let i = 0; i < keys.length - 1; i++) {
      const start = i === 0 ? 0 : splits[i - 1];
      sizes[keys[i]] = splits[i] - start;
    }
    return sizes;
  }

  // -- Reactive state --

  let sizeCache = $state({});
  let splits = $state([]);

  let activeKeys = $derived(visibleKeys(panes));

  $effect(() => {
    splits = buildSplits(activeKeys, panes, sizeCache);
  });

  function onSplitChange(newSplits) {
    sizeCache = { ...sizeCache, ...extractSizes(activeKeys, newSplits) };
  }
</script>

{#if activeKeys.length > 1}
  <SplitPane {orientation} bind:splits {minPaneSize} {minPanePx} onchange={onSplitChange}>
    {#snippet children(paneIdx)}
      {@render paneContent(activeKeys[paneIdx], paneIdx)}
    {/snippet}
  </SplitPane>
{:else if activeKeys.length === 1}
  {@render paneContent(activeKeys[0], 0)}
{/if}
