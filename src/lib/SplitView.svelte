<!--
  SplitView [container, general] — resizable split pane layout.

  Manages an array of split positions (floats in 0–1) with constraint
  resolution: handles push neighbors when dragged, and neighbors spring
  back when released. Supports horizontal and vertical orientation,
  nesting, and customization via CSS custom properties.

  Usage:
    <SplitView orientation="horizontal" bind:splits={mySplits} minPaneSize={0.05}>
      {#snippet children(paneIndex, paneCount)}
        <div>Pane {paneIndex} of {paneCount}</div>
      {/snippet}
    </SplitView>

  CSS custom properties (set on the SplitView or any ancestor):
    --sv-handle-size     Handle thickness (default: 4px)
    --sv-handle-color    Handle resting color (default: #444)
    --sv-handle-hover    Handle hover/active color (default: #007acc)
    --sv-handle-hit-pad  Extra hit-area padding around handle (default: 4px)
-->
<script>
  import { onDestroy } from "svelte";

  // -- Pure math (general) ----------------------------------------------------

  /**
   * Pure function, general. Resolves split positions after dragging handle
   * `activeIdx` by `delta` from `initial` snapshot, enforcing `minGap`
   * between all adjacent splits and boundaries [0, 1].
   *
   * Always resolves from the initial snapshot (taken at mousedown), not
   * incrementally. Dragging back restores neighbors to their original
   * positions — the "spring-back" property that tmux lacks.
   *
   * @param {number[]} initial - Split positions snapshot from mousedown
   * @param {number} activeIdx - Index of the handle being dragged
   * @param {number} delta - Fractional displacement (positive = right/down)
   * @param {number} minGap - Minimum fractional size of any pane
   * @returns {number[]} New split positions with all constraints satisfied
   *
   * @example resolveSplits([0.5], 0, 0.1, 0.1) // [0.6]
   * @example resolveSplits([0.3, 0.7], 0, 0.5, 0.1) // [0.8, 0.9]
   * @example resolveSplits([0.3, 0.7], 0, -0.25, 0.1) // [0.1, 0.7]  (clamped, neighbor unchanged)
   */
  function resolveSplits(initial, activeIdx, delta, minGap) {
    const n = initial.length;
    const result = [...initial];

    const minAllowable = (activeIdx + 1) * minGap;
    const maxAllowable = 1 - (n - activeIdx) * minGap;
    result[activeIdx] = Math.max(
      minAllowable,
      Math.min(maxAllowable, initial[activeIdx] + delta),
    );

    // Push neighbors LEFT — min(original, pushed) = stay or get pushed, never pulled
    for (let i = activeIdx - 1; i >= 0; i--) {
      result[i] = Math.min(initial[i], result[i + 1] - minGap);
    }
    // Push neighbors RIGHT
    for (let i = activeIdx + 1; i < n; i++) {
      result[i] = Math.max(initial[i], result[i - 1] + minGap);
    }

    return result;
  }

  // -- Component state --------------------------------------------------------

  let {
    /** @type {"horizontal"|"vertical"} */
    orientation = "horizontal",
    /** @type {number[]} Split positions, each in (0, 1) */
    splits = $bindable([0.5]),
    /** @type {number} Minimum fractional pane size */
    minPaneSize = 0.05,
    /** @type {(splits: number[]) => void} Called after drag ends with final positions */
    onchange = undefined,
    children,
  } = $props();

  /** @type {HTMLDivElement|undefined} */
  let containerEl = $state(undefined);
  let dragIdx = $state(-1);

  // Non-reactive drag bookkeeping
  let snapshot = [];
  let startClientPos = 0;

  const isHoriz = $derived(orientation === "horizontal");
  const paneCount = $derived(splits.length + 1);

  // -- Layout helpers ---------------------------------------------------------

  /**
   * Pure function, specific. CSS string positioning pane `index` within the split layout.
   *
   * @param {number} index - Pane index
   * @returns {string} Inline CSS
   *
   * @example // paneStyle(0) with splits=[0.5], horizontal
   * @example // => "left:0%;width:50%;top:0;bottom:0;"
   */
  function paneStyle(index) {
    const start = index === 0 ? 0 : splits[index - 1];
    const end = index === splits.length ? 1 : splits[index];
    const pos = (start * 100).toFixed(4);
    const size = ((end - start) * 100).toFixed(4);
    return isHoriz
      ? `left:${pos}%;width:${size}%;top:0;bottom:0;`
      : `top:${pos}%;height:${size}%;left:0;right:0;`;
  }

  /**
   * Pure function, specific. CSS string positioning handle `index`.
   *
   * @param {number} index - Handle index
   * @returns {string} Inline CSS
   *
   * @example // handleStyle(0) with splits=[0.5], horizontal => "left:50%"
   */
  function handleStyle(index) {
    const pos = (splits[index] * 100).toFixed(4);
    return isHoriz ? `left:${pos}%` : `top:${pos}%`;
  }

  // -- Drag handlers ----------------------------------------------------------

  /** Command, specific. Begins handle drag, captures snapshot for spring-back. */
  function onMouseDown(e, idx) {
    e.preventDefault();
    dragIdx = idx;
    startClientPos = isHoriz ? e.clientX : e.clientY;
    snapshot = [...splits];
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  /** Command, specific. Resolves constraints from snapshot on each move. */
  function onMouseMove(e) {
    if (dragIdx < 0) return;
    const containerSize = isHoriz
      ? containerEl.clientWidth
      : containerEl.clientHeight;
    const clientPos = isHoriz ? e.clientX : e.clientY;
    const delta = (clientPos - startClientPos) / containerSize;
    splits = resolveSplits(snapshot, dragIdx, delta, minPaneSize);
  }

  /** Command, specific. Ends drag, cleans up window listeners. */
  function onMouseUp() {
    const wasDragging = dragIdx >= 0;
    dragIdx = -1;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    if (wasDragging) onchange?.(splits);
  }

  onDestroy(() => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  });
</script>

<div
  class="sv-root"
  class:sv-horizontal={isHoriz}
  class:sv-vertical={!isHoriz}
  class:sv-dragging={dragIdx >= 0}
  bind:this={containerEl}
>
  {#each Array(paneCount) as _, i}
    <div class="sv-pane" style={paneStyle(i)}>
      {@render children(i, paneCount)}
    </div>
  {/each}

  {#each splits as _, i}
    <div
      class="sv-handle"
      class:sv-active={dragIdx === i}
      style={handleStyle(i)}
      onmousedown={(e) => onMouseDown(e, i)}
      role="separator"
      aria-orientation={orientation}
    ></div>
  {/each}
</div>

<style>
  .sv-root {
    --sv-handle-size: 4px;
    --sv-handle-color: #444;
    --sv-handle-hover: #007acc;
    --sv-handle-hit-pad: 4px;

    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .sv-root.sv-dragging {
    user-select: none;
  }
  .sv-root.sv-dragging .sv-pane {
    pointer-events: none;
  }

  .sv-pane {
    position: absolute;
    overflow: hidden;
  }

  .sv-handle {
    position: absolute;
    z-index: 10;
    transition: background-color 0.15s;
    background: var(--sv-handle-color);
  }

  .sv-handle::before {
    content: "";
    position: absolute;
    inset: calc(-1 * var(--sv-handle-hit-pad));
  }

  .sv-horizontal > .sv-handle {
    top: 0;
    bottom: 0;
    width: var(--sv-handle-size);
    margin-left: calc(-1 * var(--sv-handle-size) / 2);
    cursor: col-resize;
  }

  .sv-vertical > .sv-handle {
    left: 0;
    right: 0;
    height: var(--sv-handle-size);
    margin-top: calc(-1 * var(--sv-handle-size) / 2);
    cursor: row-resize;
  }

  .sv-handle:hover,
  .sv-handle.sv-active {
    background: var(--sv-handle-hover);
  }
</style>
