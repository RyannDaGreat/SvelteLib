<!--
  ColorPicker [visual, general] — a saturation/value square + hue strip + alpha
  strip + hex text field. Value in/out is an 8-digit hex string "#rrggbbaa"
  (the alpha channel is INTEGRAL, never a bolted-on second field). Every
  selection gesture applies IMMEDIATELY — there is NO commit key: dragging the
  square/strips or editing hex fires `onchange` live (an `oninput`/`onchange`
  split is provided so a host can separate live-preview from a settle event —
  see the callback docs). Plain "#rrggbb" input is accepted (treated as opaque)
  but the value we emit is always the 8-digit form so downstream storage/tween
  code (which keys on channel count) stays uniform.

  WHY built, not vendored (research 2026-07-15): no existing Svelte color
  picker is a low-effort offline vendor. svelte-awesome-color-picker is
  Svelte-5-native but drags in two npm deps (colord + svelte-awesome-slider)
  across ~13 files; vanilla-colorful is MIT/zero-dep but a Web Component, not a
  Svelte component. A fresh runes build of exactly the four controls we need is
  smaller and dependency-free. The hex<->hsva<->rgba conversions below are the
  only error-prone part and are written as pure, doctested functions.

  Usage:
    <ColorPicker bind:value={color} />                    value is "#rrggbbaa"
    <ColorPicker bind:value={color} onchange={(v) => …} /> live on every gesture
    <ColorPicker value={color} onchange={(v) => (color = v)} /> controlled

  Interaction:
    - drag in the S/V square       set saturation (x) and value/brightness (y)
    - drag the hue strip           set hue (0..360)
    - drag the alpha strip         set alpha (0..1); checkerboard shows through
    - type into the hex field      set the whole color; Enter/blur normalizes
      (a valid 3/4/6/8-digit hex applies live as you type)
    - the swatch previews the current color over a checkerboard

  CSS custom properties (default to the ambient theme tokens, then a standalone
  literal fallback — SQUARE corners by default, no dark-blue theme):
    --cp-bg, --cp-fg, --cp-fg-dim, --cp-border, --cp-radius, --cp-accent,
    --cp-square-size, --cp-strip-height, --cp-thumb-size, --cp-checker-size,
    --cp-checker-a, --cp-checker-b, --cp-font-size, --cp-gap, --cp-focus-ring
-->
<script module>
  // -- Pure color-math helpers (general, doctested) ---------------------------
  // All hue in [0,360), s/v in [0,100], r/g/b in [0,255], a in [0,1].

  /**
   * Pure function. Clamp v into [lo, hi].
   *
   * @example clamp(5, 0, 10) // 5
   * @example clamp(-3, 0, 10) // 0
   * @example clamp(15, 0, 10) // 10
   */
  export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Pure function. Two-digit lowercase hex byte for a 0..255 channel (rounded,
   * clamped). Used to assemble "#rrggbbaa" strings.
   *
   * @example hexByte(255) // "ff"
   * @example hexByte(0) // "00"
   * @example hexByte(128) // "80"
   * @example hexByte(300) // "ff"  (clamped)
   */
  export function hexByte(c) {
    return clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0");
  }

  /**
   * Pure function. True for CSS hex colors: "#rgb", "#rgba", "#rrggbb",
   * "#rrggbbaa" (case-insensitive). Mirrors the app's isHexColor so what this
   * control accepts is exactly what the document tween code accepts.
   *
   * @example isHex("#aa33ff") // true
   * @example isHex("#aa33ff80") // true
   * @example isHex("#a3f") // true
   * @example isHex("#a3f8") // true
   * @example isHex("blue") // false
   * @example isHex("#12") // false
   */
  export function isHex(s) {
    return typeof s === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s);
  }

  /**
   * Pure function. Parse any accepted hex form to {r,g,b,a} (r/g/b 0..255,
   * a 0..1). Shorthand digits double ("#f08c" -> ff 00 88 cc). A missing alpha
   * channel (3/6-digit) is opaque (a=1). Returns null for non-hex input.
   *
   * @example hexToRgba("#ff0080") // {r:255,g:0,b:128,a:1}
   * @example hexToRgba("#ff008080") // {r:255,g:0,b:128,a:0.5019607843137255}
   * @example hexToRgba("#f08") // {r:255,g:0,b:136,a:1}
   * @example hexToRgba("#f08c") // {r:255,g:0,b:136,a:0.8}
   * @example hexToRgba("nope") // null
   */
  export function hexToRgba(s) {
    if (!isHex(s)) return null;
    let h = s.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = [];
    for (let i = 0; i < h.length; i += 2) n.push(parseInt(h.slice(i, i + 2), 16));
    return { r: n[0], g: n[1], b: n[2], a: n.length === 4 ? Math.round((n[3] / 255) * 1000) / 1000 : 1 };
  }

  /**
   * Pure function. {r,g,b,a} -> "#rrggbbaa" (always 8 digits; a in 0..1 scaled
   * to a byte). The alpha channel is always emitted so channel count is uniform.
   *
   * @example rgbaToHex({r:255,g:0,b:128,a:1}) // "#ff0080ff"
   * @example rgbaToHex({r:255,g:0,b:128,a:0.5}) // "#ff008080"
   * @example rgbaToHex({r:0,g:0,b:0,a:0}) // "#00000000"
   */
  export function rgbaToHex({ r, g, b, a }) {
    return "#" + hexByte(r) + hexByte(g) + hexByte(b) + hexByte(a * 255);
  }

  /**
   * Pure function. HSV(A) -> RGB(A). h 0..360, s/v 0..100, a passes through.
   * Standard HSV sextant formula.
   *
   * @example hsvaToRgba({h:0,s:100,v:100,a:1}) // {r:255,g:0,b:0,a:1}
   * @example hsvaToRgba({h:120,s:100,v:100,a:1}) // {r:0,g:255,b:0,a:1}
   * @example hsvaToRgba({h:0,s:0,v:100,a:1}) // {r:255,g:255,b:255,a:1}
   * @example hsvaToRgba({h:240,s:100,v:50,a:0.5}) // {r:0,g:0,b:128,a:0.5}
   */
  export function hsvaToRgba({ h, s, v, a }) {
    const S = s / 100, V = v / 100;
    const c = V * S;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = V - c;
    let r = 0, g = 0, b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), a };
  }

  /**
   * Pure function. RGB(A) -> HSV(A). r/g/b 0..255, a passes through. Inverse of
   * hsvaToRgba (up to hue being undefined for grays, where it returns 0). h/s/v
   * are NOT rounded — this is the internal source of truth during interaction,
   * and rounding here would drift a color on every hex round-trip (rounding
   * happens only at the RGB boundary, in hsvaToRgba). Display code rounds.
   *
   * @example rgbaToHsva({r:255,g:0,b:0,a:1}) // {h:0,s:100,v:100,a:1}
   * @example rgbaToHsva({r:0,g:255,b:0,a:1}) // {h:120,s:100,v:100,a:1}
   * @example rgbaToHsva({r:255,g:255,b:255,a:1}) // {h:0,s:0,v:100,a:1}
   * @example rgbaToHsva({r:0,g:0,b:0,a:0.5}) // {h:0,s:0,v:0,a:0.5}
   */
  export function rgbaToHsva({ r, g, b, a }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s: s * 100, v: max * 100, a };
  }

  /**
   * Pure function. Fraction 0..1 of a pointer position `pos` along a track
   * spanning [start, start+len], clamped to the ends. Shared by the square and
   * both strips so drag math has one home.
   *
   * @example trackFraction(50, 0, 100) // 0.5
   * @example trackFraction(-10, 0, 100) // 0  (clamped)
   * @example trackFraction(200, 0, 100) // 1  (clamped)
   * @example trackFraction(30, 20, 40) // 0.25
   */
  export function trackFraction(pos, start, len) {
    return len <= 0 ? 0 : clamp((pos - start) / len, 0, 1);
  }
</script>

<script>
  let {
    /** @type {string} The color as "#rrggbbaa" (or any accepted hex). Bindable. */
    value = $bindable("#000000ff"),
    /** @type {(v:string)=>void} Fires on EVERY gesture/edit with the new
     *  "#rrggbbaa" (live preview). Selection applies immediately — no Enter. */
    oninput = undefined,
    /** @type {(v:string)=>void} Fires when a gesture SETTLES (pointerup, or a
     *  committed hex edit). For hosts that want one undo unit per drag: use
     *  oninput to preview and onchange to commit. If a host only wires
     *  onchange (the common case), it still fires live per gesture AND on
     *  settle, so "every gesture applies immediately" holds either way. */
    onchange = undefined,
    /** @type {boolean} Disable interaction. */
    disabled = false,
    /** @type {string} Accessible label prefix for the control group. */
    label = "color",
  } = $props();

  // HSVA is the INTERNAL model: hue survives at s=0/v=0 (a hex round-trip would
  // lose it, snapping the square's cursor to a corner mid-drag). We keep hsva as
  // the source of truth while interacting and sync FROM `value` only when it
  // changes externally to a color our own emission didn't produce.
  let hsva = $state(toHsva(value));
  let lastEmitted = $state(normalize(value)); // the #rrggbbaa we last sent out
  let hexDraft = $state(null); // in-progress hex text while the field is focused

  // Derived color readouts.
  const rgba = $derived(hsvaToRgba(hsva));
  const hex8 = $derived(rgbaToHex(rgba)); // always #rrggbbaa
  const hueRgb = $derived(hsvaToRgba({ h: hsva.h, s: 100, v: 100, a: 1 })); // pure hue for the square bg
  const hueCss = $derived(`rgb(${hueRgb.r}, ${hueRgb.g}, ${hueRgb.b})`);
  const solidCss = $derived(`rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`); // opaque form for the alpha-strip gradient
  const swatchCss = $derived(`rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`);
  const hexFieldValue = $derived(hexDraft ?? hex8);

  /** Query. Parse an external value to HSVA (fallback: opaque black). */
  function toHsva(v) {
    const c = hexToRgba(v);
    return c ? rgbaToHsva(c) : { h: 0, s: 0, v: 0, a: 1 };
  }
  /** Query. Normalize any accepted hex to the emitted #rrggbbaa form. */
  function normalize(v) {
    const c = hexToRgba(v);
    return c ? rgbaToHex(c) : "#000000ff";
  }

  // External value changes (a parent set `value` to something we didn't emit)
  // re-seed the internal HSVA. Comparing against lastEmitted avoids clobbering
  // hue during our own emissions (which pass through the same bound `value`).
  $effect(() => {
    const incoming = normalize(value);
    if (incoming !== lastEmitted) {
      hsva = toHsva(value);
      lastEmitted = incoming;
      hexDraft = null;
    }
  });

  // -- Emission ---------------------------------------------------------------

  /** Command. Push the current color out (bindable value + oninput). Live. */
  function emitInput() {
    const out = hex8;
    if (out === value && out === lastEmitted) return;
    lastEmitted = out;
    value = out;
    oninput?.(out);
  }
  /** Command. Signal a settle (pointerup / committed hex). */
  function emitChange() {
    onchange?.(hex8);
  }

  // -- Pointer drag on a track (square / hue / alpha) -------------------------
  // Pointer Events + setPointerCapture so a drag keeps tracking past the
  // element's bounds (Pixel-Aligner lesson: capture, not window listeners).

  // The track element is taken from the pointerdown's currentTarget (the
  // element carrying the handler), not a bind:this ref — no binding-timing
  // hazard, and pointer capture stays on the exact track that owns the gesture.
  function startDrag(e, onFraction) {
    if (disabled || e.button !== 0) return;
    const el = e.currentTarget;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // Synthetic test events have no active pointer; ignore only that.
      if (err.name !== "InvalidStateError" && err.name !== "NotFoundError") throw err;
    }
    const apply = (ev) => onFraction(fractions(el, ev));
    apply(e); // the initial down positions the thumb immediately (live)
    const move = (ev) => apply(ev);
    const up = (ev) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch { /* nothing captured (tests) — nothing to release */ }
      emitChange(); // gesture settled
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  /** Query. Pointer position as x/y fractions (0..1) within an element's box. */
  function fractions(el, e) {
    const r = el.getBoundingClientRect();
    return { fx: trackFraction(e.clientX, r.left, r.width), fy: trackFraction(e.clientY, r.top, r.height) };
  }

  function onSquareDown(e) {
    startDrag(e, ({ fx, fy }) => {
      hsva = { ...hsva, s: fx * 100, v: (1 - fy) * 100 }; // top = full value
      emitInput();
    });
  }
  function onHueDown(e) {
    startDrag(e, ({ fx }) => {
      hsva = { ...hsva, h: fx * 360 };
      emitInput();
    });
  }
  function onAlphaDown(e) {
    startDrag(e, ({ fx }) => {
      hsva = { ...hsva, a: Math.round(fx * 1000) / 1000 };
      emitInput();
    });
  }

  // -- Keyboard on the square/strips (accessible where cheap) ------------------
  const STEP_SV = 2;   // % per arrow key in the square
  const STEP_HUE = 2;  // degrees per arrow key on the hue strip
  const STEP_ALPHA = 0.02; // alpha per arrow key on the alpha strip

  function onSquareKey(e) {
    if (disabled) return;
    let { s, v } = hsva;
    if (e.key === "ArrowLeft") s -= STEP_SV;
    else if (e.key === "ArrowRight") s += STEP_SV;
    else if (e.key === "ArrowUp") v += STEP_SV;
    else if (e.key === "ArrowDown") v -= STEP_SV;
    else return;
    e.preventDefault();
    hsva = { ...hsva, s: clamp(s, 0, 100), v: clamp(v, 0, 100) };
    emitInput();
    emitChange();
  }
  function onHueKey(e) {
    if (disabled) return;
    let h = hsva.h;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") h -= STEP_HUE;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") h += STEP_HUE;
    else return;
    e.preventDefault();
    hsva = { ...hsva, h: ((h % 360) + 360) % 360 };
    emitInput();
    emitChange();
  }
  function onAlphaKey(e) {
    if (disabled) return;
    let a = hsva.a;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") a -= STEP_ALPHA;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") a += STEP_ALPHA;
    else return;
    e.preventDefault();
    hsva = { ...hsva, a: clamp(Math.round(a * 1000) / 1000, 0, 1) };
    emitInput();
    emitChange();
  }

  // -- Hex text field ---------------------------------------------------------
  // Typing a VALID hex applies live (no Enter needed); an invalid in-progress
  // draft is held without applying. Enter/blur normalizes the field to #rrggbbaa.

  function onHexInput(e) {
    const raw = e.currentTarget.value;
    hexDraft = raw;
    const withHash = raw.startsWith("#") ? raw : "#" + raw;
    if (isHex(withHash)) {
      hsva = toHsva(withHash);
      emitInput(); // live apply
    }
  }
  function onHexKey(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitHex();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hexDraft = null; // revert the field to the current color
      e.currentTarget.blur();
    }
  }
  function onHexBlur() {
    commitHex();
  }
  /** Command. Settle the hex field: normalize display, fire onchange. */
  function commitHex() {
    hexDraft = null; // hexFieldValue falls back to hex8 (normalized)
    emitChange();
  }
</script>

<div
  class="cp"
  class:cp-disabled={disabled}
  role="group"
  aria-label={label}
  style:--cp-hue={hueCss}
  style:--cp-solid={solidCss}
  style:--cp-swatch={swatchCss}
>
  <!-- Saturation / value square. Background = pure hue; white overlay left→right
       (saturation), black overlay top→bottom (value). The thumb sits at
       (s, 1-v). -->
  <div
    class="cp-square"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={`${label} saturation and brightness`}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Math.round(hsva.s)}
    aria-valuetext={`saturation ${Math.round(hsva.s)}%, brightness ${Math.round(hsva.v)}%`}
    onpointerdown={onSquareDown}
    onkeydown={onSquareKey}
  >
    <div class="cp-square-white"></div>
    <div class="cp-square-black"></div>
    <div
      class="cp-thumb cp-thumb-xy"
      style:left={`${hsva.s}%`}
      style:top={`${100 - hsva.v}%`}
      style:--cp-thumb-fill={solidCss}
    ></div>
  </div>

  <!-- Hue strip (0..360). -->
  <div
    class="cp-strip cp-hue"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={`${label} hue`}
    aria-valuemin="0"
    aria-valuemax="360"
    aria-valuenow={Math.round(hsva.h)}
    onpointerdown={onHueDown}
    onkeydown={onHueKey}
  >
    <div class="cp-thumb cp-thumb-x" style:left={`${(hsva.h / 360) * 100}%`} style:--cp-thumb-fill={hueCss}></div>
  </div>

  <!-- Alpha strip (0..1). Checkerboard beneath a transparent→solid gradient. -->
  <div
    class="cp-strip cp-alpha"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={`${label} opacity`}
    aria-valuemin="0"
    aria-valuemax="1"
    aria-valuenow={hsva.a}
    onpointerdown={onAlphaDown}
    onkeydown={onAlphaKey}
  >
    <div class="cp-alpha-fill"></div>
    <div class="cp-thumb cp-thumb-x" style:left={`${hsva.a * 100}%`} style:--cp-thumb-fill={swatchCss}></div>
  </div>

  <!-- Readout: checkerboard swatch + editable hex field. -->
  <div class="cp-readout">
    <div class="cp-swatch" aria-hidden="true"><div class="cp-swatch-fill"></div></div>
    <input
      class="cp-hex"
      type="text"
      spellcheck="false"
      autocomplete="off"
      {disabled}
      aria-label={`${label} hex`}
      value={hexFieldValue}
      oninput={onHexInput}
      onkeydown={onHexKey}
      onblur={onHexBlur}
    />
  </div>
</div>

<style>
  .cp {
    /* Theme tokens with standalone literal fallbacks (light/dark aware).
       SQUARE corners by default (--cp-radius: 0) — round only if a consumer
       opts in. No dark-blue palette. */
    --cp-bg: var(--control-bg, #ffffff);
    --cp-fg: var(--fg, #1a1a1a);
    --cp-fg-dim: var(--fg-dim, #666);
    --cp-border: var(--border, rgba(0, 0, 0, 0.25));
    --cp-radius: var(--cp-corner, 0);
    --cp-accent: var(--accent, #3b82f6);
    --cp-font-size: 0.85rem;
    --cp-gap: 8px;

    --cp-square-size: 160px;
    --cp-strip-height: 12px;
    --cp-thumb-size: 12px;

    /* Alpha/swatch checkerboard (drawn with conic-gradient — no assets). */
    --cp-checker-size: 8px;
    --cp-checker-a: var(--cp-checker-light, #ffffff);
    --cp-checker-b: var(--cp-checker-dark, #c8c8c8);

    --cp-focus-ring: color-mix(in srgb, var(--cp-accent) 55%, transparent);

    display: inline-flex;
    flex-direction: column;
    gap: var(--cp-gap);
    box-sizing: border-box;
    padding: var(--cp-gap);
    width: fit-content;
    background: var(--cp-bg);
    color: var(--cp-fg);
    border: 1px solid var(--cp-border);
    border-radius: var(--cp-radius);
    font-size: var(--cp-font-size);
    user-select: none;
    touch-action: none;
  }
  .cp-disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  /* A reusable checkerboard tile (conic-gradient), used by the alpha strip and
     the swatch as an UNDERLAY behind the translucent color. */
  .cp-alpha,
  .cp-swatch {
    background-image: conic-gradient(
      var(--cp-checker-b) 0 25%,
      var(--cp-checker-a) 0 50%,
      var(--cp-checker-b) 0 75%,
      var(--cp-checker-a) 0
    );
    background-size: var(--cp-checker-size) var(--cp-checker-size);
    background-position: 0 0;
  }

  .cp-square {
    position: relative;
    width: var(--cp-square-size);
    height: var(--cp-square-size);
    border-radius: var(--cp-radius);
    background: var(--cp-hue);
    cursor: crosshair;
    outline: none;
    overflow: hidden;
  }
  /* White gradient left→right gives saturation; black top→bottom gives value. */
  .cp-square-white {
    position: absolute;
    inset: 0;
    background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0));
  }
  .cp-square-black {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, #000, rgba(0, 0, 0, 0));
  }
  .cp-square:focus-visible {
    box-shadow: 0 0 0 2px var(--cp-focus-ring);
  }

  .cp-strip {
    position: relative;
    width: var(--cp-square-size);
    height: var(--cp-strip-height);
    border-radius: var(--cp-radius);
    outline: none;
    cursor: pointer;
  }
  .cp-strip:focus-visible {
    box-shadow: 0 0 0 2px var(--cp-focus-ring);
  }
  .cp-hue {
    background: linear-gradient(
      to right,
      #f00 0%,
      #ff0 17%,
      #0f0 33%,
      #0ff 50%,
      #00f 67%,
      #f0f 83%,
      #f00 100%
    );
  }
  /* Transparent → solid current color, over the checkerboard underlay. */
  .cp-alpha-fill {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(to right, transparent, var(--cp-solid));
  }

  /* A round thumb; the fill previews the value at that position, so the thumb
     reads against any background. Positioned by left/top percentages. */
  .cp-thumb {
    position: absolute;
    width: var(--cp-thumb-size);
    height: var(--cp-thumb-size);
    box-sizing: border-box;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    background: var(--cp-thumb-fill, transparent);
    pointer-events: none;
  }
  .cp-thumb-xy {
    transform: translate(-50%, -50%);
  }
  .cp-thumb-x {
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .cp-readout {
    display: flex;
    align-items: center;
    gap: var(--cp-gap);
  }
  .cp-swatch {
    position: relative;
    width: calc(var(--cp-strip-height) * 2);
    height: calc(var(--cp-strip-height) * 2);
    flex: none;
    border: 1px solid var(--cp-border);
    border-radius: var(--cp-radius);
    overflow: hidden;
  }
  .cp-swatch-fill {
    position: absolute;
    inset: 0;
    background: var(--cp-swatch);
  }
  .cp-hex {
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 6px;
    background: var(--cp-bg);
    color: var(--cp-fg);
    border: 1px solid var(--cp-border);
    border-radius: var(--cp-radius);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
  }
  .cp-hex:focus-visible {
    box-shadow: 0 0 0 2px var(--cp-focus-ring);
  }
</style>
