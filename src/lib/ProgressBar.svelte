<!--
  ProgressBar [visual, general] — controlled determinate/indeterminate progress.

  Omit `value` (or pass null) for indeterminate progress. Pass `value` and
  `max` for determinate progress; values outside the range are clamped.

  Usage:
    <ProgressBar label="Downloading" value={loadedBytes} max={totalBytes} />
    <ProgressBar label="Preparing download" />

  CSS custom properties:
    --progress-height, --progress-track-bg, --progress-value-bg,
    --progress-indeterminate-stripe
-->
<script>
  /**
   * Pure function. Converts a finite value and positive maximum to a visually
   * clamped percentage.
   *
   * @param {number} value - Current progress
   * @param {number} max - Positive completion value
   * @returns {number} Percentage in [0, 100]
   *
   * @example clampedPercent(30, 120) // 25
   * @example clampedPercent(150, 120) // 100
   */
  function clampedPercent(value, max) {
    if (!Number.isFinite(value)) throw new TypeError("Progress value must be finite");
    if (!Number.isFinite(max) || max <= 0) throw new RangeError("Progress maximum must be positive and finite");
    return Math.min(100, Math.max(0, value / max * 100));
  }

  let {
    /** Current progress; null or undefined selects indeterminate progress. */
    value = undefined,
    /** Positive completion value for determinate progress. */
    max = 100,
    /** Accessible name for the progress bar. */
    label = "Progress",
    /** Optional accessible text such as "24 MB of 80 MB". */
    valueText = undefined,
  } = $props();

  const determinate = $derived(value !== undefined && value !== null);
  const percent = $derived(determinate ? clampedPercent(value, max) : 0);
  const boundedValue = $derived(determinate ? Math.min(max, Math.max(0, value)) : undefined);
</script>

<div
  class="progress"
  class:indeterminate={!determinate}
  role="progressbar"
  aria-label={label}
  aria-valuemin={determinate ? 0 : undefined}
  aria-valuemax={determinate ? max : undefined}
  aria-valuenow={boundedValue}
  aria-valuetext={valueText}
  style={`--progress-value:${percent}%`}
>
  <span class="value"></span>
</div>

<style>
  .progress {
    width: 100%;
    height: var(--progress-height, 0.5rem);
    overflow: hidden;
    background: var(--progress-track-bg, rgba(255, 255, 255, 0.15));
  }

  .value {
    display: block;
    width: var(--progress-value);
    height: 100%;
    background: var(--progress-value-bg, var(--accent, #7aa2f7));
  }

  .indeterminate .value {
    width: 100%;
    background: repeating-linear-gradient(
      -45deg,
      var(--progress-indeterminate-stripe, rgba(255, 255, 255, 0.16)) 0 0.25rem,
      transparent 0.25rem 0.5rem
    );
  }
</style>
