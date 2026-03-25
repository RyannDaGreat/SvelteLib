<!--
  SplitView [headless, general] — split position controller.

  Owns an array of split positions (floats in 0–1) and drag interaction
  state. Handles constraint resolution: dragged handles push neighbors,
  and neighbors spring back when released (snapshot-based — no tmux bug).
  Renders nothing visual — passes state and actions to children.

  Usage:
    <SplitView orientation="horizontal" bind:splits={mySplits} minPaneSize={0.05}>
      {#snippet children(state, actions)}
        {#each Array(state.paneCount) as _, i}
          <div style={myPaneStyle(state, i)}>Pane {i}</div>
        {/each}
        {#each state.splits as _, i}
          <div onmousedown={(e) => actions.beginDrag(i, e)}>handle</div>
        {/each}
      {/snippet}
    </SplitView>

  State shape:
    { splits: number[], paneCount: number, orientation: string,
      dragging: boolean, dragIndex: number }

  Actions:
    beginDrag(handleIndex, mouseEvent) — start dragging a handle
    setSplits(number[])               — programmatic update (ignored mid-drag)
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

  /**
   * @typedef {Object} SplitState
   * @property {number[]} splits - Current split positions
   * @property {number} paneCount - splits.length + 1
   * @property {"horizontal"|"vertical"} orientation
   * @property {boolean} dragging - Whether a handle is being dragged
   * @property {number} dragIndex - Index of dragged handle (-1 if none)
   */

  /**
   * @typedef {Object} SplitActions
   * @property {(index: number, e: MouseEvent) => void} beginDrag - Start dragging handle
   * @property {(newSplits: number[]) => void} setSplits - Programmatic update (ignored mid-drag)
   */

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

  // -- Drag handlers ----------------------------------------------------------

  /** Command, specific. Begins handle drag, captures snapshot for spring-back. */
  function beginDrag(index, e) {
    e.preventDefault();
    dragIdx = index;
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

  /** Command, specific. Programmatic split update (ignored mid-drag). */
  function setSplits(newSplits) {
    if (dragIdx < 0) splits = [...newSplits];
  }

  onDestroy(() => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  });

  /**
   * Query, specific. Current state snapshot for children.
   * @returns {SplitState}
   */
  function getState() {
    return {
      splits,
      paneCount: splits.length + 1,
      orientation,
      dragging: dragIdx >= 0,
      dragIndex: dragIdx,
    };
  }

  /** @type {SplitActions} */
  const actions = { beginDrag, setSplits };
</script>

<div class="sv-root" bind:this={containerEl}>
  {@render children(getState(), actions)}
</div>

<style>
  .sv-root {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
