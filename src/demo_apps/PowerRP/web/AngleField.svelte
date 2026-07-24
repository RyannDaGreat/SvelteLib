<!--
  AngleField — THE "angle" property field (the angle sibling of NumericField /
  ColorField / BooleanField). It edits a heading in DEGREES with a rotary DIAL
  you drag around a circle, plus a typed-degrees box for exact entry. The
  heading convention matches the rest of the app: 0° = +x (right), 90° = +y
  (down); values wrap into [0, 360).

  WHERE IT IS USED:
    - kind:"angle" property rows, via the Inspector's field dispatcher
      (web/Inspector.svelte) — self-writes to `path` on `app` exactly like
      ColorField (preview mid-gesture, commit on settle, one undo unit; the
      row's shared KeyframeControls keyframe it like any other property).
    - the LINEAR-GRADIENT DIRECTION inside PaintField — there the write is NOT a
      single scalar (it must rewrite the paint's from/to endpoints alongside the
      angle), so PaintField passes `onpreview`/`oncommit` callbacks that own the
      write; when they are present `app`/`path` are unused.

  Live semantics (the house preview/commit contract, same as ColorField):
    drag / arrow-key nudge → onpreview (viewport re-renders live; doc unchanged)
    pointer release / typed Enter/blur → oncommit (ONE undo unit)

  Styling: inline styles over the app's --a-*/--fg/--border/--accent tokens (no
  app.css classes, no <style> block — the PaintField/ColorField-eyedropper house
  convention). The SVG uses a unitless 0..100 viewBox; those are DRAWING
  coordinates (like a path's `d`), not CSS px — the on-screen SIZE comes from
  --a-control-h. No hardcoded colors or CSS pixels.

  Props: app (nullable when callbacks are supplied), path (state path, nullable
  with callbacks), label, value (current degrees), disabled, onpreview(deg),
  oncommit(deg).
-->
<script>
  import { wrapDegrees } from "../core/properties.js";

  let {
    app = null,
    path = null,
    label,
    value = 0,
    disabled = false,
    onpreview = null,
    oncommit = null,
  } = $props();

  // ── SVG drawing geometry (unitless viewBox coordinates, NOT CSS px) ──────────
  const VIEWBOX = 100; // the dial's coordinate space is 0..VIEWBOX square
  const CENTER = VIEWBOX / 2;
  const RING_R = 42; // dial ring radius
  const KNOB_R = 7; // draggable knob radius at the needle tip
  const HUB_R = 3; // center pivot dot
  const TICK_INNER = 36; // cardinal tick inner radius
  // Keyboard nudge steps (semantic constants — degrees per arrow press).
  const NUDGE_STEP_DEG = 1;
  const NUDGE_COARSE_DEG = 15; // with Shift held

  let svgEl = $state(null);
  let dragging = $state(false);

  // The stored value, wrapped for display + geometry. tidy strips float dust so a
  // dragged/typed integer shows cleanly.
  let deg = $derived(wrapDegrees(Number(value) || 0));
  let rad = $derived((deg * Math.PI) / 180);
  // Needle tip in SVG coords (0° points +x/right, 90° points +y/down — the SVG
  // axes already run x-right / y-down, so the convention maps directly).
  let tipX = $derived(CENTER + RING_R * Math.cos(rad));
  let tipY = $derived(CENTER + RING_R * Math.sin(rad));
  let shownDeg = $derived(Math.round(deg * 10) / 10);

  // Typed-entry draft (kept synced to `deg` while the box is not focused).
  let draft = $state("");
  let editing = $state(false);
  $effect(() => {
    if (!editing) draft = String(shownDeg);
  });

  /** Command. Live-preview a heading (viewport re-renders; doc unchanged). */
  function emitPreview(d) {
    if (onpreview) onpreview(d);
    else if (app && path) app.setPreview([[path, d]]);
  }
  /** Command. Commit a heading as ONE undo unit. */
  function emitCommit(d) {
    if (oncommit) oncommit(d);
    else if (app && path) {
      app.setPreview([[path, d]]);
      app.commitPreview();
    }
  }

  /** Query. The heading (integer degrees) from a pointer event, measured from
   * the dial center — screen coords (y down) map straight onto the convention. */
  function angleFromEvent(e) {
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const raw = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    return Math.round(wrapDegrees(raw));
  }

  function onPointerDown(e) {
    if (disabled) return;
    dragging = true;
    svgEl.setPointerCapture(e.pointerId);
    emitPreview(angleFromEvent(e));
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!dragging) return;
    emitPreview(angleFromEvent(e));
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    svgEl.releasePointerCapture?.(e.pointerId);
    emitCommit(angleFromEvent(e));
  }

  /** Arrow keys nudge the heading (accessible fine control); Shift = coarse. */
  function onKeydown(e) {
    if (disabled) return;
    const step = e.shiftKey ? NUDGE_COARSE_DEG : NUDGE_STEP_DEG;
    let delta = 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
    else return;
    e.preventDefault();
    emitCommit(wrapDegrees(deg + delta));
  }

  function commitDraft() {
    editing = false;
    const parsed = parseFloat(draft);
    if (Number.isNaN(parsed)) {
      draft = String(shownDeg); // reject non-numeric silently-visible (revert display)
      return;
    }
    emitCommit(wrapDegrees(parsed));
  }
  function onDraftKeydown(e) {
    if (e.key === "Enter") {
      commitDraft();
      e.target.blur();
    } else if (e.key === "Escape") {
      editing = false;
      draft = String(shownDeg);
      e.target.blur();
      e.stopPropagation(); // don't bubble into Deselect
    }
  }
</script>

<div style="display:flex; align-items:center; gap:var(--a-sp-2);">
  <!-- The rotary dial. role=slider for a11y; drag or arrow-key to change. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={svgEl}
    viewBox="0 0 {VIEWBOX} {VIEWBOX}"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={`${label} angle`}
    aria-valuenow={Math.round(deg)}
    aria-valuemin="0"
    aria-valuemax="360"
    aria-disabled={disabled}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onkeydown={onKeydown}
    style="width:calc(var(--a-control-h) * 2); height:calc(var(--a-control-h) * 2);
           flex:none; touch-action:none; cursor:{disabled ? 'default' : 'grab'};
           opacity:{disabled ? 0.5 : 1}; border-radius:50%; outline:none;"
  >
    <!-- ring -->
    <circle cx={CENTER} cy={CENTER} r={RING_R} fill="none" stroke="var(--border)" stroke-width="2" />
    <!-- cardinal ticks (0/90/180/270) for orientation -->
    {#each [0, 90, 180, 270] as t}
      {@const tr = (t * Math.PI) / 180}
      <line
        x1={CENTER + TICK_INNER * Math.cos(tr)} y1={CENTER + TICK_INNER * Math.sin(tr)}
        x2={CENTER + RING_R * Math.cos(tr)} y2={CENTER + RING_R * Math.sin(tr)}
        stroke="var(--fg-dim)" stroke-width="1.5"
      />
    {/each}
    <!-- needle + knob -->
    <line x1={CENTER} y1={CENTER} x2={tipX} y2={tipY} stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
    <circle cx={tipX} cy={tipY} r={KNOB_R} fill="var(--accent)" />
    <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="var(--fg-dim)" />
  </svg>

  <!-- typed-degrees box -->
  <span style="display:inline-flex; align-items:center; gap:2px;">
    <input
      type="text"
      inputmode="numeric"
      spellcheck="false"
      aria-label={`${label} degrees`}
      value={draft}
      {disabled}
      oninput={(e) => { editing = true; draft = e.target.value; }}
      onfocus={() => (editing = true)}
      onblur={commitDraft}
      onkeydown={onDraftKeydown}
      style="width:3.2em; box-sizing:border-box; text-align:right; font-size:var(--a-font-sm);
             color:var(--fg); background:transparent; border:1px solid var(--border);
             border-radius:var(--radius); padding:var(--a-sp-1) var(--a-sp-2);"
    />
    <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">°</span>
  </span>
</div>
