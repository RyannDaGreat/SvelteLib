<!--
  DraggableNumber [visual, general] — click-drag numeric scrubber.

  A number you scrub by dragging — NOT a slider (a slider implies a bounded
  begin/end track; this is an unbounded scrubber like a DAW/3D-app field).
  Drag the value up/down to change it continuously; vertical drag is primary
  (drag UP to increase, DOWN to decrease). During a drag the mouse is pinned
  in place via the Pointer Lock API and motion is accumulated from
  event.movementY, so the cursor never runs off the control. If pointer lock
  is unavailable or denied, it falls back to plain drag deltas.

  Usage:
    <DraggableNumber bind:value={x} />
    <DraggableNumber bind:value={x} coefficient={0.01} min={0} max={1} step={0.05} />
    <DraggableNumber bind:value={x} wheel={false} suffix="px" />

  Interaction:
    - drag up/down          scrub the value (coefficient units per pixel)
    - Shift while dragging   fine adjustment (FINE_FACTOR × coefficient)
    - ↑ / ↓                 nudge by step (or coefficient if no step)
    - Home / End            jump to min / max (only when bounded)
    - the grip wheel rolls to mirror the accumulated drag (wheel mode)

  CSS custom properties (all default to the ambient theme tokens, then a
  standalone literal fallback):
    --dn-bg, --dn-fg, --dn-fg-dim, --dn-border, --dn-radius, --dn-padding,
    --dn-font-size, --dn-accent, --dn-hover-bg, --dn-focus-ring,
    --dn-wheel-width, --dn-wheel-height, --dn-wheel-bg, --dn-ridge,
    --dn-ridge-count, --dn-ridge-gap
-->
<script>
  // -- Pure helpers (general) -------------------------------------------------

  /**
   * Pure function. Clamp v into [min, max]. A null/undefined bound is ignored,
   * so passing only one bound clamps on one side and leaves the other open.
   *
   * @example clamp(5, 0, 10) // 5
   * @example clamp(-3, 0, 10) // 0
   * @example clamp(15, 0, 10) // 10
   * @example clamp(15, null, null) // 15  (unbounded → unchanged)
   * @example clamp(-3, 0, null) // 0  (lower bound only)
   */
  function clamp(v, min, max) {
    if (min != null && v < min) v = min;
    if (max != null && v > max) v = max;
    return v;
  }

  /**
   * Pure function. Round v to the nearest multiple of step, anchored at base.
   * A null/undefined/zero step returns v unchanged (free / continuous value).
   *
   * @example roundToStep(0.117, 0.05, 0) // 0.1
   * @example roundToStep(7, 2, 0) // 8
   * @example roundToStep(7, 2, 1) // 7  (anchored at base=1: …3,5,7,9)
   * @example roundToStep(3.14159, null, 0) // 3.14159  (no step → unchanged)
   */
  function roundToStep(v, step, base = 0) {
    if (!step) return v;
    return base + Math.round((v - base) / step) * step;
  }

  /**
   * Pure function. Format a number for display, trimming float noise. Rounds
   * to `decimals` places then strips trailing zeros, so 1.2000000001 → "1.2"
   * and whole numbers stay clean.
   *
   * @example formatValue(1.2000000001, 4) // "1.2"
   * @example formatValue(42, 4) // "42"
   * @example formatValue(-0.05, 4) // "-0.05"
   * @example formatValue(3.14159, 2) // "3.14"
   */
  function formatValue(v, decimals) {
    if (!Number.isFinite(v)) return String(v);
    const fixed = v.toFixed(decimals);
    return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  }

  /**
   * Pure function. Decimal places implied by a step, so the display precision
   * tracks the step's granularity. Falls back to `fallback` when step is unset.
   *
   * @example decimalsForStep(0.01, 4) // 2
   * @example decimalsForStep(0.5, 4) // 1
   * @example decimalsForStep(1, 4) // 0
   * @example decimalsForStep(null, 4) // 4  (no step → fallback)
   */
  function decimalsForStep(step, fallback) {
    if (!step) return fallback;
    const s = String(step);
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
  }

  // -- Props ------------------------------------------------------------------

  const FINE_FACTOR = 0.1; // Shift-drag multiplier for fine adjustment
  const DEFAULT_DECIMALS = 4; // display precision when no step constrains it
  const RIDGE_TRAVEL_PX = 48; // drag pixels that scroll the wheel by one ridge cycle

  let {
    /** @type {number} The scrubbed value. Bindable. */
    value = $bindable(0),
    /** @type {number} Units the value changes per pixel of drag. */
    coefficient = 1,
    /** @type {number|null} Lower bound; null/undefined = unbounded below. */
    min = null,
    /** @type {number|null} Upper bound; null/undefined = unbounded above. */
    max = null,
    /** @type {number|null} Round result to this step; null = continuous. */
    step = null,
    /** @type {boolean} Show the skeuomorphic grip wheel. */
    wheel = true,
    /** @type {string} Text shown before the number (e.g. "x:"). */
    prefix = "",
    /** @type {string} Text shown after the number (e.g. "px", "%"). */
    suffix = "",
    /** @type {boolean} Disable interaction. */
    disabled = false,
    /** @type {string} Accessible label for the control. */
    label = "value",
    /** @type {(v:number)=>void} Fires on every change during a drag/nudge. */
    oninput = undefined,
    /** @type {(v:number)=>void} Fires once when a drag/nudge settles. */
    onchange = undefined,
  } = $props();

  // -- State ------------------------------------------------------------------

  let rootEl;
  let dragging = $state(false);
  let locked = $state(false); // true once pointer lock is actually held
  let accum = $state(0); // total drag pixels this gesture (for the wheel roll)

  // base value captured at gesture start; the drag adds a delta onto it
  let dragStartValue = 0;
  let dragStartClientY = 0; // fallback (no pointer lock) reference point
  let lastEmitted = value; // last value we told the consumer about via onchange

  const bounded = $derived(min != null && max != null);
  const decimals = $derived(decimalsForStep(step, DEFAULT_DECIMALS));
  const display = $derived(formatValue(value, decimals));

  // The wheel scrolls its ridge pattern by the accumulated drag. Modulo keeps
  // the offset small so the CSS repeat never has to cover a huge range; the
  // pattern is seamless so the wrap is invisible.
  const wheelOffset = $derived(((accum % RIDGE_TRAVEL_PX) + RIDGE_TRAVEL_PX) % RIDGE_TRAVEL_PX);

  // -- Value application ------------------------------------------------------

  /** Command. Set value (clamp + step + reactive), firing oninput each time. */
  function applyValue(next) {
    next = roundToStep(next, step, min ?? 0);
    next = clamp(next, min, max);
    if (next === value) return;
    value = next;
    oninput?.(value);
  }

  /** Command. Fire onchange if the value moved since the last settle. */
  function commitValue() {
    if (value !== lastEmitted) {
      lastEmitted = value;
      onchange?.(value);
    }
  }

  /**
   * Command. Convert an accumulated pixel delta into a new value from the
   * gesture's start. Up (negative screen Y) increases; fine holds Shift.
   */
  function applyDragDelta(pixelsUp, fine) {
    const coeff = coefficient * (fine ? FINE_FACTOR : 1);
    applyValue(dragStartValue + pixelsUp * coeff);
  }

  // -- Pointer lock drag (primary) --------------------------------------------
  // Mirrors AnnotateBar's capture-scrub: request lock on pointerdown, drive the
  // value from movementY on the document's mousemove while locked, exit on up.
  // The mouse stays pinned so the cursor can't leave the control.

  function beginDrag(clientY) {
    dragging = true;
    accum = 0;
    dragStartValue = value;
    dragStartClientY = clientY;
    lastEmitted = value;
  }

  function onPointerDown(e) {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    rootEl?.focus();
    beginDrag(e.clientY);
    // Best-effort pointer capture keeps the fallback drag tracking past the
    // element's bounds. Synthetic test events have no active pointer, so an
    // InvalidStateError/NotFoundError here is expected — ignore only those.
    try {
      rootEl.setPointerCapture(e.pointerId);
    } catch (err) {
      if (err.name !== "InvalidStateError" && err.name !== "NotFoundError") throw err;
    }
    // requestPointerLock may return a promise (newer browsers). A rejection is
    // expected when the gesture isn't a trusted user activation (e.g. tests) —
    // we surface it as a warning and the fallback drag path takes over.
    const req = rootEl.requestPointerLock?.();
    if (req && typeof req.then === "function") {
      req.catch((err) => console.warn("DraggableNumber: pointer lock rejected:", err.message));
    }
  }

  // Fallback drag: no pointer lock, so track the real cursor via clientY.
  function onPointerMove(e) {
    if (!dragging || locked) return; // locked path is driven by onLockedMove
    const pixelsUp = dragStartClientY - e.clientY; // up is positive
    accum = -pixelsUp; // roll wheel down-for-decrease, matching motion
    applyDragDelta(pixelsUp, e.shiftKey);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    if (locked) document.exitPointerLock?.();
    else endDrag();
    rootEl?.releasePointerCapture?.(e.pointerId);
  }

  function endDrag() {
    dragging = false;
    commitValue();
  }

  // While pointer-locked the browser fires plain mouse events on the document
  // (not pointer events on the element) carrying movementY. We accumulate it.
  function onLockedMove(e) {
    if (!locked) return;
    accum += e.movementY;
    const pixelsUp = -accum; // movementY is positive when moving down
    applyDragDelta(pixelsUp, e.shiftKey);
  }

  function onLockedUp() {
    if (locked) document.exitPointerLock?.();
  }

  $effect(() => {
    function onLockChange() {
      locked = document.pointerLockElement === rootEl;
      if (locked) accum = 0; // start the wheel roll fresh from the lock point
      else if (dragging) endDrag(); // lock released (up or Esc) ends the gesture
    }
    function onLockError() {
      // Rejected lock (too-soon re-lock, no user activation) — expected; the
      // fallback drag still works. Surface it rather than swallow it.
      console.warn("DraggableNumber: pointer lock request was rejected");
    }
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    document.addEventListener("mousemove", onLockedMove);
    document.addEventListener("mouseup", onLockedUp);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      document.removeEventListener("mousemove", onLockedMove);
      document.removeEventListener("mouseup", onLockedUp);
    };
  });

  // -- Keyboard ---------------------------------------------------------------

  function nudge(dir, fine) {
    const base = step ?? coefficient;
    dragStartValue = value; // applyValue reads no start, but keep parity for fine
    const amount = base * (fine ? FINE_FACTOR : 1);
    applyValue(value + dir * amount);
    commitValue();
  }

  function onKeyDown(e) {
    if (disabled) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        nudge(1, e.shiftKey);
        break;
      case "ArrowDown":
        e.preventDefault();
        nudge(-1, e.shiftKey);
        break;
      case "Home":
        if (min == null) return;
        e.preventDefault();
        applyValue(min);
        commitValue();
        break;
      case "End":
        if (max == null) return;
        e.preventDefault();
        applyValue(max);
        commitValue();
        break;
    }
  }
</script>

<div
  class="dn"
  class:dn-dragging={dragging}
  class:dn-disabled={disabled}
  bind:this={rootEl}
  role="spinbutton"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min ?? undefined}
  aria-valuemax={max ?? undefined}
  aria-disabled={disabled || undefined}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onkeydown={onKeyDown}
>
  {#if wheel}
    <span class="dn-wheel" aria-hidden="true">
      <span class="dn-ridges" style:transform={`translateY(${wheelOffset}px)`}></span>
    </span>
  {/if}
  <span class="dn-text">
    {#if prefix}<span class="dn-affix">{prefix}</span>{/if}<span class="dn-value">{display}</span
    >{#if suffix}<span class="dn-affix">{suffix}</span>{/if}
  </span>
</div>

<style>
  .dn {
    /* Default to the host's theme tokens (light/dark aware); literals are the
       standalone fallback when no theme is present. */
    --dn-bg: var(--control-bg, rgba(20, 20, 30, 0.92));
    --dn-fg: var(--fg, #e0e0e0);
    --dn-fg-dim: var(--fg-dim, #888);
    --dn-border: var(--border, rgba(255, 255, 255, 0.18));
    --dn-accent: var(--accent, #7aa2f7);
    --dn-radius: 4px;
    --dn-padding: 4px 8px;
    --dn-font-size: 0.85rem;
    --dn-hover-bg: var(--a-hover-bg, rgba(255, 255, 255, 0.08));
    --dn-focus-ring: color-mix(in srgb, var(--dn-accent) 55%, transparent);

    /* Grip wheel geometry + skin */
    --dn-wheel-width: 12px;
    --dn-wheel-height: 20px;
    --dn-wheel-bg: linear-gradient(
      90deg,
      color-mix(in srgb, var(--dn-fg) 8%, transparent),
      color-mix(in srgb, var(--dn-fg) 22%, transparent) 50%,
      color-mix(in srgb, var(--dn-fg) 8%, transparent)
    );
    --dn-ridge: color-mix(in srgb, var(--dn-fg) 45%, transparent);
    --dn-ridge-gap: 4px; /* period of one ridge cycle; RIDGE_TRAVEL_PX = 48 = 12 cycles */
    --dn-ridge-thickness: 1px;

    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    padding: var(--dn-padding);
    background: var(--dn-bg);
    color: var(--dn-fg);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    font-size: var(--dn-font-size);
    font-variant-numeric: tabular-nums;
    cursor: ns-resize;
    user-select: none;
    touch-action: none;
    outline: none;
  }
  .dn:hover:not(.dn-disabled) {
    background: var(--dn-hover-bg);
  }
  .dn:focus-visible {
    box-shadow: 0 0 0 2px var(--dn-focus-ring);
  }
  .dn-dragging {
    background: var(--dn-hover-bg);
  }
  .dn-disabled {
    cursor: default;
    opacity: 0.5;
  }

  /* The grip wheel: a short vertical barrel with repeating grip ridges that
     scroll under a fixed viewport, plus edge shading for a rounded-cylinder
     read. Pure CSS — no assets. */
  .dn-wheel {
    position: relative;
    display: inline-block;
    width: var(--dn-wheel-width);
    height: var(--dn-wheel-height);
    flex: none;
    overflow: hidden;
    border: 1px solid var(--dn-border);
    border-radius: 2px;
    background: var(--dn-wheel-bg);
  }
  /* A tall ridge strip translated by the drag; it's twice the viewport plus a
     cycle so any translate in [0, ridge-cycle) still fully covers the window. */
  .dn-ridges {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(-1 * var(--dn-wheel-height) - var(--dn-ridge-gap));
    height: calc(3 * var(--dn-wheel-height));
    background: repeating-linear-gradient(
      0deg,
      transparent 0,
      transparent calc(var(--dn-ridge-gap) - var(--dn-ridge-thickness)),
      var(--dn-ridge) calc(var(--dn-ridge-gap) - var(--dn-ridge-thickness)),
      var(--dn-ridge) var(--dn-ridge-gap)
    );
    will-change: transform;
  }
  /* Cylinder shading: darken top/bottom edges so the barrel reads as round. */
  .dn-wheel::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.35),
      transparent 30%,
      transparent 70%,
      rgba(0, 0, 0, 0.35)
    );
  }

  .dn-text {
    display: inline-flex;
    align-items: baseline;
    gap: 2px;
    white-space: nowrap;
  }
  .dn-affix {
    color: var(--dn-fg-dim);
  }
  .dn-value {
    min-width: 1ch;
  }
</style>
