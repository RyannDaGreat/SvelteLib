<!--
  DraggableNumber [visual, general] — click-drag numeric scrubber that is ALSO
  a click-to-type field.

  A number you scrub by dragging — NOT a slider (a slider implies a bounded
  begin/end track; this is an unbounded scrubber like a DAW/3D-app field).
  Drag the value up/down to change it continuously; vertical drag is primary
  (drag UP to increase, DOWN to decrease). During a drag the mouse is pinned
  in place via the Pointer Lock API and motion is accumulated from
  event.movementY, so the cursor never runs off the control. If pointer lock
  is unavailable or denied, it falls back to plain drag deltas.

  CLICK vs DRAG: a pointer-down that RELEASES without the cursor moving past a
  small slop threshold (CLICK_SLOP_PX) is a CLICK → keyboard text entry opens
  (an inline <input>, pre-filled with the current value, select-all). Crossing
  the threshold promotes the gesture to a scrub, exactly as before. Enter/blur
  commit the typed text, Escape cancels. If the consumer supplies `onedit`, the
  click DELEGATES text entry to the consumer instead of opening the built-in
  editor (so a host field can own an equation-aware entry path).

  Usage:
    <DraggableNumber bind:value={x} />
    <DraggableNumber bind:value={x} coefficient={0.01} min={0} max={1} step={0.05} />
    <DraggableNumber bind:value={x} wheel={false} suffix="px" />
    <DraggableNumber bind:value={x} ontext={(s) => …} />          consumer parses non-numeric text
    <DraggableNumber bind:value={x} onedit={() => openMyEditor()} /> consumer owns text entry

  Interaction:
    - click (no drag)       open keyboard text entry (or delegate via onedit)
    - drag up/down          scrub the value (coefficient units per pixel)
    - Shift while dragging   fine adjustment (FINE_FACTOR × coefficient)
    - ↑ / ↓                 nudge by step (or coefficient if no step)
    - Home / End            jump to min / max (only when bounded)
    - the grip wheel rolls to mirror the accumulated drag (wheel mode); it
      STOPS rolling once the value is clamped at a bound (accumulator clamps)

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

  /**
   * Pure function. Parse trimmed text as a finite plain number, else null.
   * A leading "+"/"-" and surrounding whitespace are fine; empty, blank, or
   * anything else (arithmetic, references, "1,2", "NaN") returns null so the
   * caller can route it to the text path.
   *
   * @example parseNumber("42") // 42
   * @example parseNumber("  -0.5 ") // -0.5
   * @example parseNumber("1e3") // 1000
   * @example parseNumber("") // null
   * @example parseNumber("speed * 2") // null  (not a plain number)
   */
  function parseNumber(text) {
    const t = text.trim();
    if (t === "") return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
  }

  // -- Props ------------------------------------------------------------------

  const FINE_FACTOR = 0.1; // Shift-drag multiplier for fine adjustment
  const DEFAULT_DECIMALS = 4; // display precision when no step constrains it
  // Click-vs-drag slop: a pointer that moves less than this (in px) before
  // release counts as a CLICK (→ text entry), not a scrub. LINKED to the
  // identical click-vs-drag distinction in AnnotateBar.svelte (CLICK_SLOP_PX =
  // 4), the other pointer-lock-scrub control in this lib — same precedent, one
  // value (user rule: no arbitrary invented constants; base it on precedent and
  // link the two). Measured on movementY while locked, or clientY otherwise.
  const CLICK_SLOP_PX = 4;
  // The wheel surface moves 1:1 with the drag (like a real wheel under a
  // finger); the translate wraps at one ridge period so the loop is SEAMLESS
  // (the old 48px travel modulo made the pattern visibly "reset" mid-drag).
  const RIDGE_PERIOD_PX = 4; // must equal --dn-ridge-gap (single ridge cycle)

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
    /** @type {((s:string)=>void)|undefined} Fires when committed text does NOT
     *  parse as a plain number — the consumer decides what to do with the raw
     *  string (e.g. treat it as an equation). If absent, non-numeric text is
     *  rejected loudly with the invalid affordance (no silent fallback). */
    ontext = undefined,
    /** @type {(()=>void)|undefined} If provided, a click-without-drag calls
     *  this INSTEAD of opening the built-in text editor — the consumer owns
     *  the text-entry surface (e.g. an equation-aware field). */
    onedit = undefined,
  } = $props();

  // -- State ------------------------------------------------------------------

  let rootEl;
  let inputEl = $state(null); // the inline text-entry <input> when editing
  let dragging = $state(false);
  let locked = $state(false); // true once pointer lock is actually held
  let accum = $state(0); // clamped drag pixels this gesture (drives the wheel roll)
  let editing = $state(false); // built-in keyboard text entry is open
  let draft = $state(""); // text buffer while editing
  let invalid = $state(false); // committed text failed to parse and had no ontext

  // A gesture starts "pending": we don't know yet if it's a click or a scrub.
  // It promotes to a scrub the first frame motion passes CLICK_SLOP_PX; if the
  // pointer releases still-pending, it was a click → text entry.
  let pending = false; // pointer is down but slop not yet crossed
  let gestureMoved = 0; // max abs motion seen this gesture (px), for click detection

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
  const wheelOffset = $derived(((accum % RIDGE_PERIOD_PX) + RIDGE_PERIOD_PX) % RIDGE_PERIOD_PX);

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
   * Returns the pixel delta that the (possibly clamped) value corresponds to,
   * so the caller can pin the wheel accumulator at the wall — past a bound the
   * ridges stop rolling instead of turning uselessly against it (round-9 bug).
   */
  function applyDragDelta(pixelsUp, fine) {
    const coeff = coefficient * (fine ? FINE_FACTOR : 1);
    applyValue(dragStartValue + pixelsUp * coeff);
    // Back out the pixel offset the CURRENT (clamped) value represents. When
    // unclamped this equals pixelsUp; at a bound it saturates, so wheel roll
    // (accum) freezes exactly where the value stopped moving.
    return coeff === 0 ? pixelsUp : (value - dragStartValue) / coeff;
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
    if (editing) return; // clicks inside the open text editor stay with the input
    e.preventDefault();
    rootEl?.focus();
    // Start PENDING: bookkeeping only. We defer beginDrag()/pointer-lock until
    // motion crosses CLICK_SLOP_PX, so a plain click never enters scrub mode.
    pending = true;
    gestureMoved = 0;
    dragStartValue = value;
    dragStartClientY = e.clientY;
    lastEmitted = value;
    // Best-effort pointer capture keeps the fallback drag tracking past the
    // element's bounds. Synthetic test events have no active pointer, so an
    // InvalidStateError/NotFoundError here is expected — ignore only those.
    // (Optional-chained: the scrub math never needs rootEl, so a not-yet-bound
    // root must not abort the gesture — the drag path stays fully functional.)
    try {
      rootEl?.setPointerCapture(e.pointerId);
    } catch (err) {
      if (err.name !== "InvalidStateError" && err.name !== "NotFoundError") throw err;
    }
  }

  /** Command. Promote a pending gesture to a real scrub once slop is crossed:
   *  request pointer lock (falls back to plain drag) and enter drag mode. */
  function promoteToDrag() {
    pending = false;
    beginDrag(dragStartClientY);
    // requestPointerLock may return a promise (newer browsers). A rejection is
    // expected when the gesture isn't a trusted user activation (e.g. tests) —
    // we surface it as a warning and the fallback drag path takes over.
    const req = rootEl?.requestPointerLock?.();
    if (req && typeof req.then === "function") {
      req.catch((err) => console.warn("DraggableNumber: pointer lock rejected:", err.message));
    }
  }

  // Fallback drag: no pointer lock, so track the real cursor via clientY.
  function onPointerMove(e) {
    if (locked) return; // locked path is driven by onLockedMove
    const pixelsUp = dragStartClientY - e.clientY; // up is positive
    if (pending) {
      gestureMoved = Math.max(gestureMoved, Math.abs(pixelsUp));
      if (gestureMoved <= CLICK_SLOP_PX) return; // still a candidate click
      promoteToDrag();
    }
    if (!dragging) return;
    accum = -applyDragDelta(pixelsUp, e.shiftKey); // roll matches value motion (clamps at bounds)
  }

  function onPointerUp(e) {
    rootEl?.releasePointerCapture?.(e.pointerId);
    if (pending) {
      // Released without crossing slop → it was a CLICK: open text entry.
      pending = false;
      openTextEntry();
      return;
    }
    if (!dragging) return;
    if (locked) document.exitPointerLock?.();
    else endDrag();
  }

  function endDrag() {
    dragging = false;
    commitValue();
  }

  // -- Click-to-type text entry -----------------------------------------------

  /** Command. A click-without-drag opens keyboard entry. If the consumer
   *  supplies onedit, DELEGATE to it (the host owns the text surface, e.g. an
   *  equation-aware field); otherwise open the built-in inline <input>. */
  function openTextEntry() {
    if (onedit) {
      onedit();
      return;
    }
    editing = true;
    invalid = false;
    draft = display; // pre-fill with the current (trimmed) display value
    // Let the input render, then focus + select-all so the user can retype.
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  /**
   * Command. Commit typed text. A plain number clamps to [min,max] and fires
   * onchange; non-numeric text goes to ontext if present, else is rejected
   * loudly (console.error — no silent fallback). Returns true if it settled
   * (number or ontext), false if rejected. `keepOpenOnReject` (Enter) leaves
   * the editor open showing the invalid affordance so the user can fix it;
   * on blur we instead close and revert (no focus-trap fight).
   */
  function commitText(keepOpenOnReject) {
    const num = parseNumber(draft);
    if (num !== null) {
      applyValue(num); // clamp + step + oninput
      commitValue(); // onchange(number)
      editing = false;
      invalid = false;
      return true;
    }
    if (ontext) {
      ontext(draft);
      editing = false;
      invalid = false;
      return true;
    }
    // No number, no text handler: reject loudly (consumers wanting non-numeric
    // text must pass ontext).
    console.error(`DraggableNumber: "${draft}" is not a number and no ontext handler is set`);
    if (keepOpenOnReject) {
      invalid = true; // stay open, red affordance — user can retype
    } else {
      cancelText(); // blur with bad text → revert to the current value, close
    }
    return false;
  }

  function cancelText() {
    editing = false;
    invalid = false;
    draft = display;
  }

  function onTextKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (commitText(true)) rootEl?.focus(); // stays open (red) if rejected
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't let Escape bubble into a host's cancel/deselect
      cancelText();
      rootEl?.focus();
    }
  }

  function onTextBlur() {
    if (editing) commitText(false); // leaving the field → settle or revert, never trap focus
  }

  // While pointer-locked the browser fires plain mouse events on the document
  // (not pointer events on the element) carrying movementY. We accumulate it.
  function onLockedMove(e) {
    if (!locked) return;
    accum += e.movementY;
    const pixelsUp = -accum; // movementY is positive when moving down
    accum = -applyDragDelta(pixelsUp, e.shiftKey); // clamp roll at value bounds
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
    if (disabled || editing) return; // while editing, the <input> owns the keys
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
  class:dn-editing={editing}
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
  {#if editing}
    <!-- Built-in keyboard entry (only when the consumer did NOT take over via
         onedit). Structural/unskinned; look-and-feel is the consumer's. -->
    <input
      bind:this={inputEl}
      class="dn-input"
      class:dn-invalid={invalid}
      type="text"
      spellcheck="false"
      aria-label={label}
      bind:value={draft}
      onkeydown={onTextKeyDown}
      onblur={onTextBlur}
    />
  {:else}
    {#if wheel}
      <span class="dn-wheel" aria-hidden="true">
        <span class="dn-ridges" style:transform={`translateY(${wheelOffset}px)`}></span>
      </span>
    {/if}
    <span class="dn-text">
      {#if prefix}<span class="dn-affix">{prefix}</span>{/if}<span class="dn-value">{display}</span
      >{#if suffix}<span class="dn-affix">{suffix}</span>{/if}
    </span>
  {/if}
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

    /* Grip wheel geometry. The wheel ships UNSKINNED (flat, transparent) —
       look-and-feel belongs to the consumer's stylesheet via these hooks
       (user rule: a lib component must not be opinionated about skin). */
    --dn-wheel-width: 12px;
    --dn-wheel-height: 20px;
    --dn-wheel-bg: transparent;
    --dn-ridge: color-mix(in srgb, var(--dn-fg) 45%, transparent);
    --dn-ridge-gap: 4px; /* period of one ridge cycle — MUST equal the ridgePeriod prop for a seamless loop */
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
  .dn-editing {
    cursor: text;
  }

  /* Inline text-entry input. Structural only (fills the box, inherits font,
     no chrome) — skin belongs to the consumer via the --dn-* hooks / their
     own stylesheet, exactly like the rest of the component. */
  .dn-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  /* Rejected commit (non-numeric text, no ontext handler) — the consumer can
     restyle via this hook; the standalone fallback tints the accent red-ish. */
  .dn-input.dn-invalid {
    color: var(--dn-invalid, #e06c75);
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
