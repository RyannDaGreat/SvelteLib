<!--
  AxisReorder [headless, general] — controlled one-axis reorder mechanics.

  The consumer renders every slot and drag ghost. Attach `actions.slot(item)`
  to each measured slot, and call `actions.begin(item, event)` from its drag
  handle. Immediate preview begins after `threshold` pixels and commits once
  on pointer release. A click without a drag calls `onactivate`. Consumers
  choose where touch scrolling remains valid with ordinary `touch-action` CSS.
-->
<script>
  import { onDestroy, untrack } from "svelte";

  const DEFAULT_THRESHOLD = 4;

  /** Query. Returns the conventional ID of an item. */
  function defaultKey(item) {
    return item.id;
  }

  /** Query. Returns an event coordinate on the configured axis. */
  function coordinate(event, axis) {
    return axis === "x" ? event.clientX : event.clientY;
  }

  /** Query. Returns the start and size of a rectangle on one axis. */
  function axisBounds(rect, axis) {
    return axis === "x"
      ? { start: rect.left, size: rect.width }
      : { start: rect.top, size: rect.height };
  }

  /**
   * Pure function. Moves one item to an index in a copied sequence.
   *
   * @param {unknown[]} values - Complete ordered sequence
   * @param {number} source - Existing item index
   * @param {number} target - Desired item index after removal
   * @returns {unknown[]}
   *
   * @example moved(["a", "b", "c"], 0, 2) // ["b", "c", "a"]
   */
  function moved(values, source, target) {
    const next = [...values];
    const [value] = next.splice(source, 1);
    next.splice(target, 0, value);
    return next;
  }

  /**
   * Pure function. Inserts the dragged item after strictly earlier midpoints.
   *
   * @param {{key:unknown,item:unknown}[]} entries - Unique keyed items
   * @param {unknown} draggedKey - Key of the lifted item
   * @param {number} midpoint - Current ghost midpoint
   * @param {Map<unknown,number>} midpoints - Grab-time slot midpoints
   * @returns {{key:unknown,item:unknown}[]}
   *
   * @example preview([{key:"a",item:1},{key:"b",item:2}], "a", 21, new Map([["a",10],["b",20]])).map(entry => entry.key) // ["b", "a"]
   */
  function preview(entries, draggedKey, midpoint, midpoints) {
    const source = entries.findIndex(entry => entry.key === draggedKey);
    const target = entries.filter((entry, index) => entry.key !== draggedKey && (
      midpoints.get(entry.key) < midpoint
      || (midpoints.get(entry.key) === midpoint && index < source)
    )).length;
    return moved(entries, source, target);
  }

  let {
    axis = "x",
    items = [],
    getKey = defaultKey,
    threshold = DEFAULT_THRESHOLD,
    onchange = undefined,
    onactivate = undefined,
    children
  } = $props();

  let previewItems = $state(untrack(() => items));
  let drag = $state(null);
  let pending = null;
  let capture = null;
  const slots = new Map();

  /** Query. Returns unique keyed entries or throws before interaction. */
  function entries(values) {
    const result = values.map(item => ({ key: getKey(item), item }));
    const keys = result.map(entry => entry.key);
    if (keys.some(key => key === undefined) || new Set(keys).size !== keys.length) {
      throw new Error("AxisReorder items require unique defined keys");
    }
    return result;
  }

  /** Query. Returns the DOM attachment that registers one rendered slot. */
  function slot(item) {
    const key = getKey(item);

    /** Command. Registers this node until Svelte detaches it. */
    function attach(node) {
      slots.set(key, node);

      /** Command. Removes this exact node without disturbing a replacement. */
      function detach() {
        if (slots.get(key) === node) slots.delete(key);
      }

      return detach;
    }

    return attach;
  }

  /** Command. Removes pointer capture and every listener owned by one gesture. */
  function releaseCapture() {
    if (!capture) return;
    const { element, pointerId } = capture;
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", cancel);
    element.removeEventListener("lostpointercapture", cancel);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    capture = null;
  }

  /** Command. Restores the controlled input order and clears one gesture. */
  function clear() {
    releaseCapture();
    pending = null;
    drag = null;
    previewItems = items;
  }

  /** Command. Starts a potential primary-button reorder or activation. */
  function begin(item, event) {
    if (event.button !== 0 || event.isPrimary === false || pending) return;
    const keyed = entries(items);
    const key = getKey(item);
    const slotNodes = keyed.map(entry => slots.get(entry.key));
    if (!keyed.some(entry => entry.key === key) || slotNodes.some(node => !node)) {
      throw new Error("Every AxisReorder item must have one attached slot");
    }
    const captureElement = slotNodes[0].parentElement;
    if (!captureElement || slotNodes.some(node => node.parentElement !== captureElement)) {
      throw new Error("AxisReorder slots must be sibling elements");
    }
    const sourceRect = slots.get(key).getBoundingClientRect();
    const source = axisBounds(sourceRect, axis);
    const start = coordinate(event, axis);
    const midpoints = new Map(keyed.map((entry, index) => {
      const bounds = axisBounds(slotNodes[index].getBoundingClientRect(), axis);
      return [entry.key, bounds.start + bounds.size / 2];
    }));
    if ([...midpoints.values()].some((value, index, values) => index > 0 && values[index - 1] >= value)) {
      throw new Error("AxisReorder slots must increase along their axis");
    }
    pending = { item, key, keyed, midpoints, start, grab: start - source.start, size: source.size, rect: sourceRect, pointerId: event.pointerId };
    capture = { element: captureElement, pointerId: event.pointerId };
    capture.element.addEventListener("pointermove", move);
    capture.element.addEventListener("pointerup", finish);
    capture.element.addEventListener("pointercancel", cancel);
    capture.element.addEventListener("lostpointercapture", cancel);
    capture.element.setPointerCapture(event.pointerId);
  }

  /** Command. Updates the fixed-axis ghost and immediate prospective order. */
  function move(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const current = coordinate(event, axis);
    if (!drag && Math.abs(current - pending.start) < threshold) return;
    event.preventDefault();
    const position = current - pending.grab;
    const next = preview(pending.keyed, pending.key, position + pending.size / 2, pending.midpoints);
    previewItems = next.map(entry => entry.item);
    drag = { item: pending.item, axis, position, size: pending.size, rect: pending.rect };
  }

  /** Command. Commits one preview or activates one un-dragged item. */
  function finish(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const item = pending.item;
    const next = previewItems;
    const dragged = drag !== null;
    if (dragged) event.preventDefault();
    clear();
    if (dragged) onchange?.(next);
    else onactivate?.(item);
  }

  /** Command. Cancels one matching gesture without publishing its preview. */
  function cancel(event) {
    if (event && pending && event.pointerId !== pending.pointerId) return;
    clear();
  }

  /** Command. Routes keyboard-generated clicks to activation without duplicating pointer clicks. */
  function click(item, event) {
    if (event.detail === 0) onactivate?.(item);
  }

  /** Query. Returns whether an item owns the temporarily hidden source slot. */
  function isSource(item) {
    return drag !== null && getKey(item) === pending?.key;
  }

  /** Query. Returns the current render state for the consumer snippet. */
  function snapshot() {
    return { items: previewItems, drag, isSource };
  }

  const actions = { slot, begin, click, cancel };

  $effect(() => {
    const nextItems = items;
    entries(nextItems);
    if (axis !== "x" && axis !== "y") throw new Error('AxisReorder axis must be "x" or "y"');
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error("AxisReorder threshold must be nonnegative and finite");
    untrack(() => {
      if (pending) clear();
      else previewItems = nextItems;
    });
  });

  onDestroy(clear);
</script>

{@render children(snapshot(), actions)}
