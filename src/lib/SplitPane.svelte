<!--
  SplitPane [visual, general] — styled resizable split pane layout.

  Renders positioned panes and draggable handles. Uses SplitView internally
  for state management and constraint resolution.
  Supports horizontal and vertical orientation, nesting, and theming
  via CSS custom properties.

  Usage:
    <SplitPane orientation="horizontal" splits={[0.3, 0.7]} minPaneSize={0.05}>
      {#snippet children(paneIndex, paneCount)}
        <div>Pane {paneIndex} of {paneCount}</div>
      {/snippet}
    </SplitPane>

  CSS custom properties (set on SplitPane or any ancestor):
    --sp-handle-size     Handle thickness (default: 4px)
    --sp-handle-color    Handle resting color (default: #444)
    --sp-handle-hover    Handle hover/active color (default: #007acc)
    --sp-handle-hit-pad  Extra hit-area padding (default: 4px)
-->
<script>
  import SplitView from "./SplitView.svelte";

  // -- Layout helpers (general) -----------------------------------------------

  /**
   * Pure function, general. Fractional start position of pane `index`
   * within a split layout.
   *
   * @param {number[]} splits - Split positions
   * @param {number} index - Pane index
   * @returns {number} Fractional start (0 for first pane)
   *
   * @example paneStart([], 0) // 0
   * @example paneStart([0.3, 0.7], 0) // 0
   * @example paneStart([0.3, 0.7], 1) // 0.3
   * @example paneStart([0.3, 0.7], 2) // 0.7
   */
  function paneStart(splits, index) {
    return index === 0 ? 0 : splits[index - 1];
  }

  /**
   * Pure function, general. Fractional end position of pane `index`
   * within a split layout.
   *
   * @param {number[]} splits - Split positions
   * @param {number} index - Pane index
   * @returns {number} Fractional end (1 for last pane)
   *
   * @example paneEnd([], 0) // 1
   * @example paneEnd([0.3, 0.7], 0) // 0.3
   * @example paneEnd([0.3, 0.7], 1) // 0.7
   * @example paneEnd([0.3, 0.7], 2) // 1
   */
  function paneEnd(splits, index) {
    return index === splits.length ? 1 : splits[index];
  }

  /**
   * Pure function, general. Inline CSS positioning a pane within a split layout.
   *
   * @param {object} state - SplitView state
   * @param {number} index - Pane index
   * @returns {string} Inline CSS string
   *
   * @example // computePaneStyle({splits:[0.5], orientation:"horizontal"}, 0)
   * @example // => "left:0.0000%;width:50.0000%;top:0;bottom:0;"
   */
  function computePaneStyle(state, index) {
    const start = paneStart(state.splits, index);
    const end = paneEnd(state.splits, index);
    const pos = (start * 100).toFixed(4);
    const size = ((end - start) * 100).toFixed(4);
    return state.orientation === "horizontal"
      ? `left:${pos}%;width:${size}%;top:0;bottom:0;`
      : `top:${pos}%;height:${size}%;left:0;right:0;`;
  }

  /**
   * Pure function, general. Inline CSS positioning a handle within a split layout.
   *
   * @param {object} state - SplitView state
   * @param {number} index - Handle index
   * @returns {string} Inline CSS string
   *
   * @example // computeHandleStyle({splits:[0.5], orientation:"horizontal"}, 0)
   * @example // => "left:50.0000%"
   */
  function computeHandleStyle(state, index) {
    const pos = (state.splits[index] * 100).toFixed(4);
    return state.orientation === "horizontal"
      ? `left:${pos}%`
      : `top:${pos}%`;
  }

  // -- Component --------------------------------------------------------------

  let {
    /** @type {"horizontal"|"vertical"} */
    orientation = "horizontal",
    /** @type {number[]} Split positions, each in (0, 1) */
    splits = $bindable([0.5]),
    /** @type {number} Minimum fractional pane size */
    minPaneSize = 0.05,
    /** @type {(splits: number[]) => void} Called after drag ends */
    onchange = undefined,
    /** Snippet receiving (paneIndex, paneCount) for each pane */
    children: paneContent,
  } = $props();
</script>

<SplitView {orientation} bind:splits {minPaneSize} {onchange}>
  {#snippet children(state, actions)}
    <div
      class="sp-layout"
      class:sp-horizontal={state.orientation === "horizontal"}
      class:sp-vertical={state.orientation === "vertical"}
      class:sp-dragging={state.dragging}
    >
      {#each Array(state.paneCount) as _, i}
        <div class="sp-pane" style={computePaneStyle(state, i)}>
          {@render paneContent(i, state.paneCount)}
        </div>
      {/each}

      {#each state.splits as _, i}
        <div
          class="sp-handle"
          class:sp-active={state.dragIndex === i}
          style={computeHandleStyle(state, i)}
          onmousedown={(e) => actions.beginDrag(i, e)}
          role="separator"
          aria-orientation={state.orientation}
        ></div>
      {/each}
    </div>
  {/snippet}
</SplitView>

<style>
  .sp-layout {
    --sp-handle-size: 4px;
    --sp-handle-color: #444;
    --sp-handle-hover: #007acc;
    --sp-handle-hit-pad: 4px;

    position: relative;
    width: 100%;
    height: 100%;
  }

  .sp-layout.sp-dragging {
    user-select: none;
  }
  .sp-layout.sp-dragging .sp-pane {
    pointer-events: none;
  }

  .sp-pane {
    position: absolute;
    overflow: hidden;
  }

  .sp-handle {
    position: absolute;
    z-index: 10;
    transition: background-color 0.15s;
    background: var(--sp-handle-color);
  }

  .sp-handle::before {
    content: "";
    position: absolute;
    inset: calc(-1 * var(--sp-handle-hit-pad));
  }

  .sp-horizontal > .sp-handle {
    top: 0;
    bottom: 0;
    width: var(--sp-handle-size);
    margin-left: calc(-1 * var(--sp-handle-size) / 2);
    cursor: col-resize;
  }

  .sp-vertical > .sp-handle {
    left: 0;
    right: 0;
    height: var(--sp-handle-size);
    margin-top: calc(-1 * var(--sp-handle-size) / 2);
    cursor: row-resize;
  }

  .sp-handle:hover,
  .sp-handle.sp-active {
    background: var(--sp-handle-hover);
  }
</style>
