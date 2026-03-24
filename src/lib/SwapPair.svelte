<!--
  SwapPair [visual, general] — swap the visual order of two elements via CSS order.

  Wraps each element in a div with CSS `order`, so both stay mounted
  (no DOM destruction — safe for stateful elements like video).

  Parent must be a flex or grid container for `order` to take effect.

  Usage:
    <SwapPair swapped={held}>
      {#snippet a()}<video src="a.mp4" />{/snippet}
      {#snippet b()}<video src="b.mp4" />{/snippet}
    </SwapPair>
-->
<script>
  let { swapped = false, a, b } = $props();
</script>

<div class="swap-item" style="order: {swapped ? 1 : 0}">{@render a()}</div>
<div class="swap-item" style="order: {swapped ? 0 : 1}">{@render b()}</div>
